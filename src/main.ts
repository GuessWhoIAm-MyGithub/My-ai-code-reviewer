import { readFileSync } from "fs";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import parseDiff, { File, Change } from "parse-diff";
import minimatch from "minimatch";
import { createProvider, AIProvider } from "./providers";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const API_KEY: string =
  core.getInput("API_KEY") || core.getInput("OPENAI_API_KEY");
const API_MODEL: string =
  core.getInput("API_MODEL") || core.getInput("OPENAI_API_MODEL") || "gpt-4";
const API_PROVIDER: string = core.getInput("API_PROVIDER") || "openai";
const API_BASE_URL: string = core.getInput("API_BASE_URL") || "";
const MAX_TOKENS: number = parseInt(core.getInput("MAX_TOKENS") || "16384", 10);
// Approximate token budget (prompt instructions + diff + file context) per reviewed file
const CONTEXT_WINDOW_TOKENS: number = parseInt(
  core.getInput("CONTEXT_WINDOW_TOKENS") || "20480",
  10
);

if (!API_KEY) {
  core.setFailed("API_KEY (or OPENAI_API_KEY) is required.");
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const provider: AIProvider = createProvider(API_PROVIDER, {
  apiKey: API_KEY,
  model: API_MODEL,
  baseUrl: API_BASE_URL || undefined,
  maxTokens: MAX_TOKENS,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
  headSha: string;
}

// A single review comment targeting a whole file. `line` is only kept as a
// fallback anchor in case the API rejects file-level comments.
interface FileReviewComment {
  body: string;
  path: string;
  line?: number;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
    headSha: prResponse.data.head.sha,
  };
}

async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string[] | null> {
  try {
    const response = await octokit.repos.getContent({ owner, repo, path, ref });
    const data = response.data;
    if (Array.isArray(data) || data.type !== "file") return null;
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return content.split("\n");
  } catch {
    return null;
  }
}

// Rough heuristic for code/diff content: ~4 characters per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const PROMPT_OVERHEAD_TOKENS = 2000; // prompt instructions + PR title/description
const CONTEXT_LINES = 20; // unchanged lines of surrounding code kept around each hunk

function extractContextWindow(
  fileLines: string[],
  chunks: import("parse-diff").Chunk[],
  tokenBudget: number
): string {
  const maxChars = tokenBudget * 4;
  // 收集每个 chunk 变更区域的行范围（1-based）
  const ranges: Array<[number, number]> = chunks.map((chunk) => {
    const start = Math.max(1, chunk.newStart - CONTEXT_LINES);
    const end = Math.min(
      fileLines.length,
      chunk.newStart + chunk.newLines + CONTEXT_LINES - 1
    );
    return [start, end];
  });

  // 合并重叠区间
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    if (merged.length > 0 && s <= merged[merged.length - 1][1] + 1) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }

  // 收集行，超出 token 预算即截断
  const resultLines: string[] = [];
  let usedChars = 0;
  for (const [s, e] of merged) {
    for (let i = s; i <= e; i++) {
      const line = `${String(i).padStart(4, " ")} | ${fileLines[i - 1]}`;
      if (usedChars + line.length + 1 > maxChars) {
        resultLines.push("     | ... (truncated to fit context window)");
        return resultLines.join("\n");
      }
      resultLines.push(line);
      usedChars += line.length + 1;
    }
  }
  return resultLines.join("\n");
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function getChangedFilesBetweenCommits(
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string
): Promise<Set<string>> {
  const response = await octokit.repos.compareCommits({
    owner,
    repo,
    base: baseSha,
    head: headSha,
  });
  const files = response.data.files ?? [];
  return new Set(files.map((f) => f.filename));
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<FileReviewComment[]> {
  const comments: FileReviewComment[] = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    if (file.chunks.length === 0) continue;

    // Fit diff + surrounding file context into the context-window token budget
    const diffText = formatFileDiff(file);
    const contextBudget =
      CONTEXT_WINDOW_TOKENS - PROMPT_OVERHEAD_TOKENS - estimateTokens(diffText);
    // Skip fetching the file when there is no meaningful room left for context
    const fileLines =
      contextBudget > 512
        ? await getFileContent(
            prDetails.owner,
            prDetails.repo,
            file.to!,
            prDetails.headSha
          )
        : null;
    const fileContext = fileLines
      ? extractContextWindow(fileLines, file.chunks, contextBudget)
      : null;
    const prompt = createFilePrompt(file, prDetails, fileContext, diffText);
    const aiResponse = await getAIResponse(prompt);
    // Files without findings simply produce no comment
    comments.push(...createFileComment(file, aiResponse ?? []));
  }
  return comments;
}

function getNewFileLineNumber(change: Change): number | null {
  switch (change.type) {
    case "add":
      return change.ln;
    case "normal":
      return change.ln2;
    case "del":
      return null; // deleted lines don't exist in the new file
  }
}

function formatChange(change: Change): string {
  const newLine = getNewFileLineNumber(change);
  const lineLabel = newLine != null ? String(newLine) : "-";
  const prefix =
    change.type === "add" ? "+" : change.type === "del" ? "-" : " ";
  // change.content already has +/- prefix from parse-diff, strip it for clean formatting
  const content =
    change.content.startsWith("+") || change.content.startsWith("-")
      ? change.content.slice(1)
      : change.content;
  return `${lineLabel} ${prefix} ${content}`;
}

function formatFileDiff(file: File): string {
  return file.chunks
    .map((chunk) => {
      const header = chunk.content;
      const lines = chunk.changes.map(formatChange).join("\n");
      return `${header}\n${lines}`;
    })
    .join("\n\n");
}

function createFilePrompt(
  file: File,
  prDetails: PRDetails,
  fileContext: string | null,
  diffText: string
): string {
  const contextSection = fileContext
    ? `\n文件上下文（供参考，无需对此部分发表意见）：\n\n\`\`\`\n${fileContext}\n\`\`\`\n`
    : "";

  return `你的任务是审查 Pull Request。指令如下：
- 只输出 JSON，不要输出任何自然语言描述、前言或解释。
- 以如下 JSON 格式返回结果：{"reviews": [{"lineNumber": <行号>, "severity": "<critical|high|medium>", "reviewComment": "<审查意见>"}]}
  - critical：必然触发的问题——代码逻辑本身就是错的，只要执行到此处就会崩溃或产生错误结果（空指针解引用、数组越界、整数截断导致计算错误、逻辑判断反向等）
  - high：条件触发的严重问题——需要特定场景才暴露，但一旦触发影响严重（并发访问导致的竞态或数据损坏、资源泄漏积累导致耗尽、内部可变状态被外部修改导致不一致等）
  - medium：不触发失败但增加风险的问题——当前不会出错，但让代码更脆弱或难以维护（封装不当、命名歧义、职责过重等）
- lineNumber 必须是新文件中的行号（标有"+"或空格的行），不能是被删除的行（标有"-"的行）。
- 只对新增（"+"）或上下文（" "）行进行评论，不对删除（"-"）行进行评论。
- 不要给出正面评价或赞美。
- 如果整个文件没有值得提出的问题，"reviews" 直接返回空数组，不要为了评论而勉强找问题。
- 忽略纯代码风格、格式化或命名偏好类的琐碎问题，除非它们会带来实际风险。
- 以 GitHub Markdown 格式书写评论。
- 仅将给定的描述用于整体背景理解，只对代码本身进行评论。
- 重要：绝对不要建议在代码中添加注释。
- 每条意见必须说明该问题会导致什么后果，而不只是描述问题本身。
- 如果相邻行有多个问题，请合并为一条审查意见，放在最相关的行上。
- 请重点审查以下维度：
  - 安全性：未校验的输入、注入风险、敏感信息泄露、权限控制缺失
  - 正确性：空值/null 未处理、边界条件、异常未捕获、逻辑错误、数值运算错误（浮点精度丢失、整数截断、单位混用、溢出）
  - 并发安全：非线程安全对象在共享状态中使用、竞态条件、共享可变状态被并发访问或修改
  - 资源管理：IO/连接/文件等资源未释放、未使用 try-with-resources 或等效的资源关闭机制
  - 性能：不必要的重复计算、循环中的昂贵操作
  - 可维护性：重复逻辑、函数职责过重、命名歧义、对外暴露内部可变状态

请审查文件"${file.to}"中的以下代码差异，并在撰写回复时将 Pull Request 标题和描述纳入考量。

Diff 格式说明：每行以新文件行号（或被删除行用"-"表示）开头，随后是变更类型标识（"+"表示新增，"-"表示删除，" "表示上下文/未变更），然后是代码内容。

Pull Request 标题：${prDetails.title}
Pull Request 描述：

---
${prDetails.description}
---
${contextSection}
待审查的 Git Diff：

\`\`\`diff
${diffText}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
  severity: "critical" | "high" | "medium";
}> | null> {
  return provider.getReview(prompt);
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
};
const SEVERITY_BADGE: Record<string, string> = {
  critical: "🔴 **Critical**",
  high: "🟠 **High**",
  medium: "🔵 **Medium**",
};

function createFileComment(
  file: File,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
    severity: "critical" | "high" | "medium";
  }>
): FileReviewComment[] {
  if (!file.to || aiResponses.length === 0) return [];

  // Valid new-file line numbers across all chunks, used for "Line N" references
  const validLines = new Set<number>();
  for (const chunk of file.chunks) {
    for (const change of chunk.changes) {
      const ln = getNewFileLineNumber(change);
      if (ln != null) {
        validLines.add(ln);
      }
    }
  }

  // Sort by severity before rendering
  const sorted = [...aiResponses].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2)
  );

  // Merge everything into a single file-level comment; keep line references
  // only where they point at an actual new-file line
  const mergedBody = sorted
    .map((r) => {
      const badge = SEVERITY_BADGE[r.severity] ?? SEVERITY_BADGE.medium;
      const line = Number(r.lineNumber);
      const lineRef = validLines.has(line) ? ` **Line ${line}:**` : "";
      return `${badge}${lineRef} ${r.reviewComment}`;
    })
    .join("\n\n");

  // First changed line, kept only as a fallback anchor for line-anchored comments
  const anchorLine = validLines.size ? Math.min(...validLines) : undefined;

  return [{ body: mergedBody, path: file.to, line: anchorLine }];
}

async function getMergeSuggestion(
  prDetails: PRDetails,
  files: File[],
  comments: FileReviewComment[]
): Promise<string | null> {
  const changedFiles = files
    .filter((f) => f.to && f.to !== "/dev/null")
    .map((f) => f.to)
    .join(", ");

  const issuesSummary =
    comments.length > 0
      ? comments.map((c) => `- [${c.path}] ${c.body}`).join("\n")
      : "No issues found.";

  const prompt = `你是一位资深代码审查员。请根据以下 Pull Request 信息和代码审查结果，给出合并建议。

Pull Request 标题：${prDetails.title}
Pull Request 描述：
---
${prDetails.description}
---

变更文件：${changedFiles}
已审查文件总数：${files.length}
发现问题总数：${comments.length}

发现的审查问题：
${issuesSummary}

请按以下格式给出回复（使用 GitHub Markdown）：

1. 以标题开头："## 🤖 AI 代码审查 - 合并建议"
2. 给出明确建议：✅ **建议合并** 或 ❌ **不建议合并**
3. 提供"### 摘要"章节，简要概述变更内容
4. 提供"### 原因"章节，说明建议或不建议合并的理由
5. 如有问题，添加"### 待解决问题"章节，列出主要关注点
6. 最后以"### 风险等级"作结：低 / 中 / 高

请保持简洁、可操作性强，使用专业语气。`;

  return provider.chat(prompt);
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: FileReviewComment[]
): Promise<void> {
  try {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      // One file-level comment per file instead of inline comments on diff lines.
      // subject_type is supported by the REST API but missing from octokit 19 typings.
      comments: comments.map((c) => ({
        body: c.body,
        path: c.path,
        subject_type: "file",
      })) as unknown as { body: string; path: string; line: number }[],
      event: "COMMENT",
    });
  } catch (error) {
    // Older API versions reject file-level comments; retry anchored to a line
    console.warn(
      "File-level review comments rejected, falling back to line-anchored comments:",
      error instanceof Error ? error.message : error
    );
    const lineComments = comments.filter((c) => c.line != null);
    if (lineComments.length === 0) throw error;
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      comments: lineComments.map((c) => ({
        body: c.body,
        path: c.path,
        line: c.line!,
      })),
      event: "COMMENT",
    });
  }
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened" || eventData.action === "synchronize") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  let filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  // 对 synchronize 事件，只审查本次 push 中变更的文件，避免重复审查
  if (eventData.action === "synchronize") {
    try {
      const changedFiles = await getChangedFilesBetweenCommits(
        prDetails.owner,
        prDetails.repo,
        eventData.before,
        eventData.after
      );
      filteredDiff = filteredDiff.filter((file) =>
        changedFiles.has(file.to ?? "")
      );
    } catch (e) {
      console.warn(
        "Could not determine incremental changes, reviewing all files:",
        e instanceof Error ? e.message : e
      );
    }
  }

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }

  // Post merge suggestion as a top-level PR comment
  const mergeSuggestion = await getMergeSuggestion(
    prDetails,
    filteredDiff,
    comments
  );
  if (mergeSuggestion) {
    await octokit.issues.createComment({
      owner: prDetails.owner,
      repo: prDetails.repo,
      issue_number: prDetails.pull_number,
      body: mergeSuggestion,
    });
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
