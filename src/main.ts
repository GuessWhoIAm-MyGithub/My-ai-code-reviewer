import { readFileSync } from "fs";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import parseDiff, { File } from "parse-diff";
import minimatch from "minimatch";
import { createProvider, AIProvider } from "./providers";
import {
  estimateTokens,
  extractImportSpecifiers,
  resolveImportSpecifier,
  formatFileDiff,
  getNewFileLineNumber,
  buildReviewGroups,
  selectCallerCandidates,
  summarizeChangedFiles,
  MAX_REFERENCE_CANDIDATES,
  MAX_REFERENCES_PER_BATCH,
} from "./analysis";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const API_KEY: string =
  core.getInput("API_KEY") || core.getInput("OPENAI_API_KEY");
const API_MODEL: string =
  core.getInput("API_MODEL") || core.getInput("OPENAI_API_MODEL") || "gpt-4";
const API_PROVIDER: string = core.getInput("API_PROVIDER") || "openai";
const API_BASE_URL: string = core.getInput("API_BASE_URL") || "";
// Response (output) token cap. 20480 works with every provider's default
// model; raise it via the MAX_TOKENS input for endpoints that accept larger
// outputs (e.g. 131072 on Anthropic-compatible endpoints with 512K context).
const MAX_TOKENS: number = parseInt(
  core.getInput("MAX_TOKENS") || "20480",
  10
);
// Approximate token budget (prompt instructions + diffs + file context +
// reference files) per review batch. Defaults sized for a 256K-input model so
// a typical PR is reviewed in a single cross-file call.
const CONTEXT_WINDOW_TOKENS: number = parseInt(
  core.getInput("CONTEXT_WINDOW_TOKENS") || "262144",
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

// A single review comment rendered as one merged body per file, anchored to
// the file's first changed line.
interface FileReviewComment {
  body: string;
  path: string;
  line?: number;
}

// One finding as returned by the AI for a (possibly multi-file) batch review.
// `file` tells which batch file the finding belongs to; optional because
// single-file batches may legitimately omit it. `relatedFiles` lists the
// other files a cross-file finding involves.
interface AIReviewFinding {
  file?: string;
  relatedFiles?: string[];
  lineNumber: string;
  reviewComment: string;
  severity: "critical" | "high" | "medium";
}

// An unchanged repo file included in a batch prompt as read-only context.
type ReferenceRole = "caller" | "dependency";
interface ReferenceFile {
  path: string;
  content: string;
  role: ReferenceRole;
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

async function getRepoTree(
  owner: string,
  repo: string,
  ref: string
): Promise<string[] | null> {
  try {
    const response = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: ref,
      recursive: "true",
    });
    return response.data.tree
      .filter((entry) => entry.type === "blob" && entry.path)
      .map((entry) => entry.path!);
  } catch (e) {
    console.warn(
      "Could not fetch repository tree, reference discovery disabled:",
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

const PROMPT_OVERHEAD_TOKENS = 2000; // prompt instructions + PR title/description
const CONTEXT_LINES = 20; // unchanged lines of surrounding code kept around each hunk
// estimateTokens() assumes ~4 chars/token, which underestimates CJK-heavy
// content; keep 10% headroom so batched prompts stay inside the model input limit
const TOKEN_ESTIMATE_SAFETY = 0.9;
// Share of the batch token budget usable for unchanged related reference files
const REFERENCE_BUDGET_RATIO = 0.25;

function batchTokenBudget(): number {
  return Math.floor(
    (CONTEXT_WINDOW_TOKENS - PROMPT_OVERHEAD_TOKENS) * TOKEN_ESTIMATE_SAFETY
  );
}

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

  const reviewable = parsedDiff.filter(
    (file) => file.to && file.to !== "/dev/null" && file.chunks.length > 0
  );
  if (reviewable.length === 0) return comments;

  // Fetch full contents once per changed file: needed both for import
  // analysis and for per-file diff context
  const contents = new Map<string, string[] | null>();
  await Promise.all(
    reviewable.map(async (file) => {
      contents.set(
        file.to!,
        await getFileContent(
          prDetails.owner,
          prDetails.repo,
          file.to!,
          prDetails.headSha
        )
      );
    })
  );

  // Resolve import edges between changed files; fall back to added diff lines
  // when the file content is unavailable
  const changedPaths = new Set(reviewable.map((f) => f.to!));
  const importsOf = new Map<string, Set<string>>();
  const specifiersOf = new Map<string, string[]>();
  for (const file of reviewable) {
    const lines = contents.get(file.to!);
    const text = lines
      ? lines.join("\n")
      : file.chunks
          .flatMap((chunk) => chunk.changes)
          .filter((change) => change.type !== "del")
          .map((change) => change.content.replace(/^[+-]/, ""))
          .join("\n");
    const specs = extractImportSpecifiers(file.to!, text);
    specifiersOf.set(file.to!, specs);
    const deps = new Set<string>();
    for (const spec of specs) {
      const resolved = resolveImportSpecifier(file.to!, spec, changedPaths);
      if (resolved && resolved !== file.to!) deps.add(resolved);
    }
    importsOf.set(file.to!, deps);
  }

  const repoTree = await getRepoTree(
    prDetails.owner,
    prDetails.repo,
    prDetails.headSha
  );
  const fetchCache = new Map<string, string[] | null>();

  for (const batch of buildReviewGroups(
    reviewable,
    importsOf,
    batchTokenBudget()
  )) {
    try {
      comments.push(
        ...(await reviewBatch(
          batch,
          parsedDiff,
          contents,
          specifiersOf,
          repoTree,
          changedPaths,
          prDetails,
          fetchCache
        ))
      );
    } catch (e) {
      console.warn(
        `Batch review failed for [${batch
          .map((f) => f.to)
          .join(", ")}], skipping:`,
        e instanceof Error ? e.message : e
      );
    }
  }
  return comments;
}

// Discover unchanged repo files related to the batch: callers (files whose
// imports resolve into the batch — they surface breaking changes like "the
// signature changed but this usage was not updated") and forward dependencies
// (modules the batch calls, kept for contract checking). All failures degrade
// to "no references".
async function findReferenceFiles(
  batch: File[],
  specifiersOf: Map<string, string[]>,
  changedPaths: Set<string>,
  repoTree: string[],
  prDetails: PRDetails,
  tokenBudget: number,
  fetchCache: Map<string, string[] | null>
): Promise<ReferenceFile[]> {
  const batchPaths = new Set(batch.map((f) => f.to!));
  const repoPathSet = new Set(repoTree);

  const fetchLines = async (path: string): Promise<string[] | null> => {
    if (!fetchCache.has(path)) {
      fetchCache.set(
        path,
        await getFileContent(
          prDetails.owner,
          prDetails.repo,
          path,
          prDetails.headSha
        )
      );
    }
    return fetchCache.get(path)!;
  };

  // Insertion-ordered path → role; callers are discovered first so they win the cap
  const found = new Map<string, ReferenceRole>();

  for (const candidate of selectCallerCandidates(
    [...batchPaths],
    repoTree,
    changedPaths
  )) {
    if (found.size >= MAX_REFERENCES_PER_BATCH) break;
    const lines = await fetchLines(candidate);
    if (!lines) continue;
    const importsBatch = extractImportSpecifiers(
      candidate,
      lines.join("\n")
    ).some(
      (spec) => resolveImportSpecifier(candidate, spec, batchPaths) != null
    );
    if (importsBatch) found.set(candidate, "caller");
  }

  if (found.size < MAX_REFERENCES_PER_BATCH) {
    for (const file of batch) {
      for (const spec of specifiersOf.get(file.to!) ?? []) {
        if (found.size >= MAX_REFERENCES_PER_BATCH) break;
        const resolved = resolveImportSpecifier(file.to!, spec, repoPathSet);
        if (!resolved || changedPaths.has(resolved) || found.has(resolved)) {
          continue;
        }
        const lines = await fetchLines(resolved);
        if (lines) found.set(resolved, "dependency");
      }
    }
  }

  // Fill contents within the reference budget; callers take precedence over
  // dependencies when the budget runs out
  const ordered = [...found.entries()].sort(
    (a, b) => (a[1] === "caller" ? 0 : 1) - (b[1] === "caller" ? 0 : 1)
  );
  const refs: ReferenceFile[] = [];
  let usedTokens = 0;
  for (const [path, role] of ordered) {
    const lines = await fetchLines(path);
    if (!lines) continue;
    const remainingTokens = tokenBudget - usedTokens;
    if (remainingTokens < 512) break;
    const maxChars = remainingTokens * 4;
    let content = lines.join("\n");
    if (content.length > maxChars) {
      content =
        content.slice(0, maxChars) + "\n... (truncated to fit reference budget)";
    }
    usedTokens += estimateTokens(content);
    refs.push({ path, content, role });
  }
  return refs;
}

// Review one batch of related files in a single AI call and map the findings
// back onto individual files.
async function reviewBatch(
  batch: File[],
  allFiles: File[],
  contents: Map<string, string[] | null>,
  specifiersOf: Map<string, string[]>,
  repoTree: string[] | null,
  changedPaths: Set<string>,
  prDetails: PRDetails,
  fetchCache: Map<string, string[] | null>
): Promise<FileReviewComment[]> {
  const diffTexts = new Map<string, string>();
  let diffTokens = 0;
  for (const file of batch) {
    const text = formatFileDiff(file);
    diffTexts.set(file.to!, text);
    diffTokens += estimateTokens(text);
  }

  const totalBudget = batchTokenBudget();

  // Reference files get at most their budget share, and only if the diffs
  // leave meaningful room
  const references: ReferenceFile[] = [];
  if (repoTree && totalBudget - diffTokens > 512) {
    try {
      references.push(
        ...(await findReferenceFiles(
          batch,
          specifiersOf,
          changedPaths,
          repoTree,
          prDetails,
          Math.min(
            Math.floor(totalBudget * REFERENCE_BUDGET_RATIO),
            totalBudget - diffTokens - 512
          ),
          fetchCache
        ))
      );
    } catch (e) {
      console.warn(
        "Reference discovery failed, continuing without references:",
        e instanceof Error ? e.message : e
      );
    }
  }
  const referenceTokens = references.reduce(
    (s, r) => s + estimateTokens(r.content),
    0
  );

  // Per-file same-file context from whatever budget is left after diffs and
  // references; skipped entirely when there is no meaningful room
  const contexts = new Map<string, string | null>();
  const contextBudget = totalBudget - diffTokens - referenceTokens;
  const perFileBudget = Math.floor(contextBudget / batch.length);
  for (const file of batch) {
    const lines = perFileBudget > 512 ? contents.get(file.to!) ?? null : null;
    contexts.set(
      file.to!,
      lines ? extractContextWindow(lines, file.chunks, perFileBudget) : null
    );
  }

  const prompt = createBatchPrompt(
    batch,
    prDetails,
    contexts,
    diffTexts,
    references,
    summarizeChangedFiles(allFiles)
  );
  const aiResponse = await getAIResponse(prompt);
  if (!aiResponse || aiResponse.length === 0) return [];

  // Map findings back to batch files: exact path → path suffix → unique
  // basename → drop (guards against the model inventing file paths)
  const byFile = new Map<string, AIReviewFinding[]>();
  for (const finding of aiResponse) {
    const claimed =
      typeof finding.file === "string" ? finding.file.trim() : "";
    let target: File | undefined;
    if (claimed) {
      target =
        batch.find((f) => f.to === claimed) ??
        batch.find((f) => f.to!.endsWith("/" + claimed));
      if (!target) {
        const base = claimed.split("/").pop();
        const matches = batch.filter((f) => f.to!.split("/").pop() === base);
        if (matches.length === 1) target = matches[0];
      }
    } else if (batch.length === 1) {
      // Single-file batches may legitimately omit the file field
      target = batch[0];
    }
    if (!target) {
      console.warn(
        `Dropping review finding for unrecognized file "${finding.file}"`
      );
      continue;
    }
    const arr = byFile.get(target.to!) ?? [];
    arr.push(finding);
    byFile.set(target.to!, arr);
  }

  const comments: FileReviewComment[] = [];
  for (const file of batch) {
    comments.push(...createFindingComments(file, byFile.get(file.to!) ?? []));
  }
  return comments;
}

function createBatchPrompt(
  files: File[],
  prDetails: PRDetails,
  contexts: Map<string, string | null>,
  diffTexts: Map<string, string>,
  references: ReferenceFile[],
  changedFileOverview: string
): string {
  const fileList = files.map((f) => `- ${f.to}`).join("\n");

  const fileSections = files
    .map((file) => {
      const context = contexts.get(file.to!);
      const contextBlock = context
        ? `\n该文件上下文（供参考，无需对此部分发表意见）：\n\n\`\`\`\n${context}\n\`\`\`\n`
        : "";
      return `### 文件：${file.to}\n${contextBlock}\n待审查的 Git Diff：\n\n\`\`\`diff\n${
        diffTexts.get(file.to!) ?? ""
      }\n\`\`\`\n`;
    })
    .join("\n");

  const referencesSection =
    references.length > 0
      ? `\n关联参考文件（本次 PR 未修改，仅供理解模块间的调用关系，绝对不要对这些文件的内容发表意见）：\n\n${references
          .map(
            (r) =>
              `#### 参考文件：${r.path}（${
                r.role === "caller"
                  ? "调用了本次变更文件的使用方"
                  : "被本次变更文件调用的依赖"
              }）\n\`\`\`\n${r.content}\n\`\`\``
          )
          .join("\n\n")}\n`
      : "";

  return `你的任务是审查 Pull Request 中的多个相互关联的文件。指令如下：
- 只输出 JSON，不要输出任何自然语言描述、前言或解释。
- 以如下 JSON 格式返回结果：{"reviews": [{"file": "<文件路径>", "lineNumber": <行号>, "severity": "<critical|high|medium>", "reviewComment": "<审查意见>", "relatedFiles": ["<相关文件路径>"]}]}
  - critical：必然触发的问题——代码逻辑本身就是错的，只要执行到此处就会崩溃或产生错误结果（空指针解引用、数组越界、整数截断导致计算错误、逻辑判断反向等）
  - high：条件触发的严重问题——需要特定场景才暴露，但一旦触发影响严重（并发访问导致的竞态或数据损坏、资源泄漏积累导致耗尽、内部可变状态被外部修改导致不一致等）
  - medium：不触发失败但增加风险的问题——当前不会出错，但让代码更脆弱或难以维护（封装不当、命名歧义、职责过重等）
- relatedFiles：当问题涉及多个文件（跨文件联动问题）时，列出所有涉及文件的完整路径（file 字段所指文件也包含在内）；单文件问题返回空数组。
- file 字段必须原样复制下方"待审查文件列表"中列出的某个路径，绝对不要编造列表之外的文件。
- lineNumber 必须是 file 字段所指文件的新文件行号（标有"+"或空格的行），不能是被删除的行（标有"-"的行）。
- 只对新增（"+"）或上下文（" "）行进行评论，不对删除（"-"）行发表评论，也不对参考文件发表评论。
- 不要给出正面评价或赞美。
- 如果所有文件都没有值得提出的问题，"reviews" 直接返回空数组，不要为了评论而勉强找问题。
- 忽略纯代码风格、格式化或命名偏好类的琐碎问题，除非它们会带来实际风险。
- 以 GitHub Markdown 格式书写评论。
- 仅将给定的描述用于整体背景理解，只对代码本身进行评论。
- 重要：绝对不要建议在代码中添加注释。
- 每条意见必须说明该问题会导致什么后果，而不只是描述问题本身。
- 如果相邻行有多个问题，请合并为一条审查意见，放在最相关的行上。
- 跨文件一致性是本次审查的重点：多个文件的修改通常是同一个功能的联动变更，请重点检查它们之间是否协调一致：
  - 函数/接口/方法的签名、参数、返回值在一处变更后，所有文件（含参考文件）中的调用方是否同步适配
  - 类型、常量、枚举、配置键的重命名或删除是否在所有使用处同步更新
  - 模块间契约（错误码、事件名、序列化结构、API 路径与参数）是否相互匹配
  - 联动修改是否完整，是否存在"改了一处、漏了另一处"的情况
  - 本次变更是否会破坏参考文件（未修改的使用方）中的现有调用
- 请重点审查以下维度：
  - 安全性：未校验的输入、注入风险、敏感信息泄露、权限控制缺失
  - 正确性：空值/null 未处理、边界条件、异常未捕获、逻辑错误、数值运算错误（浮点精度丢失、整数截断、单位混用、溢出）
  - 并发安全：非线程安全对象在共享状态中使用、竞态条件、共享可变状态被并发访问或修改
  - 资源管理：IO/连接/文件等资源未释放、未使用 try-with-resources 或等效的资源关闭机制
  - 性能：不必要的重复计算、循环中的昂贵操作
  - 可维护性：重复逻辑、函数职责过重、命名歧义、对外暴露内部可变状态

请审查下列文件中的代码差异，并在撰写回复时将 Pull Request 标题和描述纳入考量。

Diff 格式说明：每行以新文件行号（或被删除行用"-"表示）开头，随后是变更类型标识（"+"表示新增，"-"表示删除，" "表示上下文/未变更），然后是代码内容。

Pull Request 标题：${prDetails.title}
Pull Request 描述：

---
${prDetails.description}
---
本 PR 全部变更文件（仅供了解整体改动范围，其中部分文件可能不在本次审查列表中）：
${changedFileOverview}

待审查文件列表（file 字段只能从中选择）：
${fileList}
${referencesSection}
${fileSections}`;
}

async function getAIResponse(
  prompt: string
): Promise<AIReviewFinding[] | null> {
  // Providers surface transient API/parse failures as null; retry once before
  // giving up, since a failed batch now loses several files at once
  const first = await provider.getReview(prompt);
  if (first) return first;
  console.warn("AI review call returned no result, retrying once...");
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

// One review comment per finding, anchored to the finding's own line when it
// is a valid new-file line (the file's first changed line otherwise).
// Cross-file findings append the list of files they involve.
function createFindingComments(
  file: File,
  findings: AIReviewFinding[]
): FileReviewComment[] {
  if (!file.to || findings.length === 0) return [];

  // Valid new-file line numbers across all chunks, used for anchoring
  const validLines = new Set<number>();
  for (const chunk of file.chunks) {
    for (const change of chunk.changes) {
      const ln = getNewFileLineNumber(change);
      if (ln != null) {
        validLines.add(ln);
      }
    }
  }
  const fallbackAnchor = validLines.size ? Math.min(...validLines) : undefined;

  // Post the most severe findings first
  const sorted = [...findings].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2)
  );

  return sorted.map((r) => {
    const badge = SEVERITY_BADGE[r.severity] ?? SEVERITY_BADGE.medium;
    const line = Number(r.lineNumber);
    const anchored = validLines.has(line) ? line : undefined;
    const lineRef = anchored != null ? ` **Line ${anchored}:**` : "";
    const related = (r.relatedFiles ?? []).filter(
      (f) => typeof f === "string" && f
    );
    const relatedSection = related.length
      ? `\n\n**相关文件：** ${related.map((f) => `\`${f}\``).join("、")}`
      : "";
    return {
      body: `${badge}${lineRef} ${r.reviewComment}${relatedSection}`,
      path: file.to!,
      line: anchored ?? fallbackAnchor,
    };
  });
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
  // One comment per file, anchored to the file's first changed line. True
  // file-level comments (subject_type: "file") are only supported by the
  // single-comment endpoint, not by createReview — attempting them here was
  // always rejected with a 422.
  const lineComments = comments.filter((c) => c.line != null);
  if (lineComments.length < comments.length) {
    console.warn(
      `Skipping ${comments.length - lineComments.length} comment(s) without a valid anchor line`
    );
  }
  if (lineComments.length === 0) return;
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
