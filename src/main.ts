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

if (!API_KEY) {
  core.setFailed("API_KEY (or OPENAI_API_KEY) is required.");
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const provider: AIProvider = createProvider(API_PROVIDER, {
  apiKey: API_KEY,
  model: API_MODEL,
  baseUrl: API_BASE_URL || undefined,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
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
  };
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

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    if (file.chunks.length === 0) continue;

    // Send all chunks of a file in one prompt
    const prompt = createFilePrompt(file, prDetails);
    const aiResponse = await getAIResponse(prompt);
    if (aiResponse) {
      const newComments = createFileComment(file, aiResponse);
      if (newComments.length > 0) {
        comments.push(...newComments);
      }
    }
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
  const content = change.content.startsWith("+") || change.content.startsWith("-")
    ? change.content.slice(1)
    : change.content;
  return `${lineLabel} ${prefix} ${content}`;
}

function createFilePrompt(file: File, prDetails: PRDetails): string {
  const allChunksFormatted = file.chunks
    .map((chunk) => {
      const header = chunk.content;
      const lines = chunk.changes.map(formatChange).join("\n");
      return `${header}\n${lines}`;
    })
    .join("\n\n");

  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- The lineNumber must be a line number from the NEW version of the file (lines marked with "+" or " ", NOT lines marked with "-").
- Only comment on added ("+") or context (" ") lines. Do NOT comment on deleted ("-") lines.
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.
- If you have multiple issues on nearby lines, combine them into ONE review comment on the most relevant line.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.

The diff format: each line starts with the new-file line number (or "-" for deleted lines), followed by a change type indicator ("+" for added, "-" for deleted, " " for context/unchanged), then the code.

Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${allChunksFormatted}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  return provider.getReview(prompt);
}

function createFileComment(
  file: File,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  if (!file.to) return [];

  // Collect all valid new-file line numbers across all chunks
  const validLines = new Set<number>();
  for (const chunk of file.chunks) {
    for (const change of chunk.changes) {
      const ln = getNewFileLineNumber(change);
      if (ln != null) {
        validLines.add(ln);
      }
    }
  }

  // Filter to valid responses only
  const validResponses = aiResponses.filter((r) => {
    const line = Number(r.lineNumber);
    if (!validLines.has(line)) {
      console.warn(
        `Skipping comment: line ${line} is not a valid new-file line for ${file.to}`
      );
      return false;
    }
    return true;
  });

  if (validResponses.length === 0) return [];

  // Merge all comments into one, posted on the first mentioned line
  const firstLine = Number(validResponses[0].lineNumber);
  const mergedBody = validResponses
    .map((r) => `**Line ${r.lineNumber}:** ${r.reviewComment}`)
    .join("\n\n");

  return [
    {
      body: mergedBody,
      path: file.to,
      line: firstLine,
    },
  ];
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
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

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
