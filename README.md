# AI Code Reviewer

AI Code Reviewer is a GitHub Action that leverages AI to provide intelligent feedback and suggestions on your pull requests. It supports **OpenAI**, **Anthropic (Claude)**, and **Google Gemini** as configurable providers. This tool helps improve code quality and saves developers time by automating the code review process.

## Features

- Reviews pull requests using OpenAI, Anthropic, or Google Gemini APIs.
- Cross-file review: files linked by imports are reviewed together in a single request, with unchanged callers/dependencies included as reference context, to catch inconsistent linked changes. Linkage detection covers JS/TS, Python, Go, Java/Kotlin, and Swift (SPM module targets plus type-name references, since Swift files in one module link without imports).
- Configurable AI provider, model, and base URL via workflow inputs.
- Provides intelligent comments and suggestions for improving your code.
- Filters out files that match specified exclude patterns.
- Backward compatible with existing OpenAI-only configurations.
- Easy to set up and integrate into your GitHub workflow.

## Setup

1. Get an API key from your preferred provider:

   - [OpenAI](https://platform.openai.com/signup)
   - [Anthropic](https://console.anthropic.com/)
   - [Google AI Studio](https://aistudio.google.com/apikey)

2. Add the API key as a GitHub Secret in your repository (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`). You can find more information about GitHub Secrets [here](https://docs.github.com/en/actions/reference/encrypted-secrets).

3. Create a `.github/workflows/code_review.yml` file in your repository with one of the configurations below.

### OpenAI

```yaml
name: AI Code Reviewer
on:
  pull_request:
    types: [opened, synchronize]
permissions: write-all
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3

      - name: AI Code Reviewer
        uses: GuessWhoIAm-MyGithub/My-ai-code-reviewer@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          API_KEY: ${{ secrets.OPENAI_API_KEY }}
          API_PROVIDER: "openai"
          API_MODEL: "gpt-4"
          exclude: "**/*.json, **/*.md"
```

### Anthropic (Claude)

```yaml
name: AI Code Reviewer
on:
  pull_request:
    types: [opened, synchronize]
permissions: write-all
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3

      - name: AI Code Reviewer
        uses: GuessWhoIAm-MyGithub/My-ai-code-reviewer@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          API_PROVIDER: "anthropic"
          API_MODEL: "claude-sonnet-4-20250514"
          exclude: "**/*.json, **/*.md"
```

### Google Gemini

```yaml
name: AI Code Reviewer
on:
  pull_request:
    types: [opened, synchronize]
permissions: write-all
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3

      - name: AI Code Reviewer
        uses: GuessWhoIAm-MyGithub/My-ai-code-reviewer@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          API_KEY: ${{ secrets.GEMINI_API_KEY }}
          API_PROVIDER: "gemini"
          API_MODEL: "gemini-pro"
          exclude: "**/*.json, **/*.md"
```

### Custom Base URL

You can point OpenAI or Anthropic to a custom endpoint (e.g., Azure OpenAI, local proxy):

```yaml
- name: AI Code Reviewer
  uses: GuessWhoIAm-MyGithub/My-ai-code-reviewer@main
  with:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    API_KEY: ${{ secrets.API_KEY }}
    API_PROVIDER: "openai"
    API_MODEL: "gpt-4"
    API_BASE_URL: "https://your-custom-endpoint.com/v1"
```

> **Note:** Custom base URL is supported for OpenAI and Anthropic providers. Gemini does not support custom base URLs.

## Inputs

| Input                   | Required | Default    | Description                                                                        |
| ----------------------- | -------- | ---------- | ---------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`          | Yes      | —          | GitHub token to interact with the repository                                       |
| `API_KEY`               | Yes\*    | `""`       | API key for the AI provider                                                        |
| `API_PROVIDER`          | No       | `"openai"` | AI provider: `openai`, `anthropic`, or `gemini`                                    |
| `API_MODEL`             | No       | `"gpt-4"`  | Model name (e.g., `gpt-4`, `claude-sonnet-4-20250514`, `gemini-pro`)               |
| `API_BASE_URL`          | No       | `""`       | Custom API base URL (overrides provider default)                                   |
| `MAX_TOKENS`            | No       | `20480`    | Max response tokens; raise for endpoints with larger outputs (e.g. `131072` on Anthropic-compatible endpoints) |
| `CONTEXT_WINDOW_TOKENS` | No       | `262144`   | Approximate token budget per review batch (instructions + diffs + context + references)   |
| `exclude`               | No       | `""`       | Glob patterns to exclude files, comma-separated                                           |

\*You can also use the deprecated `OPENAI_API_KEY` and `OPENAI_API_MODEL` inputs for backward compatibility.

## How It Works

The AI Code Reviewer GitHub Action:

1. Retrieves the pull request diff when a PR is opened or updated.
2. Filters out files matching the exclude patterns.
3. Groups the changed files into review batches: files linked by import relationships (or sharing a directory) are reviewed together in a single AI request, so cross-file consistency issues (a changed function signature vs. its callers, renamed constants/types, module contracts) can be detected. With the default 256K budget a typical PR is reviewed in one single request; oversized PRs are split, evicting the least-connected files first.
4. Additionally fetches a small number of unchanged related files (callers of the changed code and modules it depends on) and includes them as read-only reference context, which surfaces breaking changes like "the interface changed but this usage was not updated".
5. Skips files for which the AI finds nothing worth flagging.
6. Posts one line-anchored review comment per finding — cross-file findings list all files they involve — and keeps a single up-to-date merge suggestion comment on the PR.
7. On follow-up pushes, files changed in the push are re-reviewed and the action's previous review threads on those files are automatically resolved: a resolved thread that is not re-flagged means the issue was fixed, while still-present issues get fresh comments — so the PR's open threads always reflect the current state of the code.
8. Comment `/review` on the PR at any time to force a full re-scan: every file is re-reviewed with the latest code as context and all previous threads converge to fixed/unfixed. This also closes threads whose fix landed in a different file than the one they were flagged on. Each `/review` posts a fresh summary comment (visible in the timeline and notified to watchers), while regular pushes keep updating the latest summary in place.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests to improve the AI Code Reviewer GitHub Action.

Let the maintainer generate the final package (`npm run build` & `npm run package`).

## Releasing

Every push to `main` automatically publishes a new version via the [Release workflow](.github/workflows/release.yml):

- The version number follows [conventional commits](https://www.conventionalcommits.org/): `feat:` bumps the minor version, `fix:` (or anything else) bumps the patch version, and `BREAKING CHANGE` / `type!:` bumps the major version.
- A release with auto-generated notes is created for each version, and a floating major tag (`v1`) always points to the latest release of that major version.
- Consumers are encouraged to pin a major version (`uses: GuessWhoIAm-MyGithub/My-ai-code-reviewer@v1`) instead of `@main`.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
