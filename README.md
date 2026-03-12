# AI Code Reviewer

AI Code Reviewer is a GitHub Action that leverages AI to provide intelligent feedback and suggestions on your pull requests. It supports **OpenAI**, **Anthropic (Claude)**, and **Google Gemini** as configurable providers. This tool helps improve code quality and saves developers time by automating the code review process.

## Features

- Reviews pull requests using OpenAI, Anthropic, or Google Gemini APIs.
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
        uses: freeedcom/ai-codereviewer@main
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
        uses: freeedcom/ai-codereviewer@main
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
        uses: freeedcom/ai-codereviewer@main
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
        uses: freeedcom/ai-codereviewer@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          API_KEY: ${{ secrets.API_KEY }}
          API_PROVIDER: "openai"
          API_MODEL: "gpt-4"
          API_BASE_URL: "https://your-custom-endpoint.com/v1"
```

> **Note:** Custom base URL is supported for OpenAI and Anthropic providers. Gemini does not support custom base URLs.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `GITHUB_TOKEN` | Yes | — | GitHub token to interact with the repository |
| `API_KEY` | Yes* | `""` | API key for the AI provider |
| `API_PROVIDER` | No | `"openai"` | AI provider: `openai`, `anthropic`, or `gemini` |
| `API_MODEL` | No | `"gpt-4"` | Model name (e.g., `gpt-4`, `claude-sonnet-4-20250514`, `gemini-pro`) |
| `API_BASE_URL` | No | `""` | Custom API base URL (overrides provider default) |
| `exclude` | No | `""` | Glob patterns to exclude files, comma-separated |

*You can also use the deprecated `OPENAI_API_KEY` and `OPENAI_API_MODEL` inputs for backward compatibility.

## How It Works

The AI Code Reviewer GitHub Action:

1. Retrieves the pull request diff when a PR is opened or updated.
2. Filters out files matching the exclude patterns.
3. Parses the diff into file chunks with proper line number tracking.
4. Sends each chunk to the configured AI provider with the PR title and description as context.
5. Validates the AI's response — only comments targeting valid new-file line numbers are posted.
6. Posts review comments directly on the relevant lines of the pull request.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests to improve the AI Code Reviewer GitHub Action.

Let the maintainer generate the final package (`npm run build` & `npm run package`).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
