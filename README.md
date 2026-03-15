# Annotate.ai

**Annotate.ai** is an AI-powered, context-aware coding and annotation assistant for Visual Studio Code. It leverages advanced Large Language Models (LLMs) via **Groq** and a Serverless Vector Database (RAG) via **Astra DB** to deeply understand your codebase and commit history. It helps you write comments, understand code, review pull requests, and manage your Git workflow seamlessly.

## 🚀 Features

* **AI Annotations:** Automatically generate intelligent inline comments for selected code snippets or orchestrate full-file documentation.
* **Hover Explainer:** Instantly demystify complex code lines by simply hovering over them. Uses **RAG** against your codebase for deep context.
* **AI Code Review:** Get a Senior Engineer-level code review of your local changes before you commit.
* **Commit & PR Generation:** Automatically generate conventional commit messages and detailed Pull Request descriptions based on your git diffs.
* **Commit History RAG:** It indexes your historical commits in Astra DB to learn your repository's commit style and perfectly mimic it in future AI-generated commit messages.
* **Git Blame & File History:** Visualize Git line history with inline blame code lenses and explore file commit history in a dedicated sidebar view.
* **RAG Workspace Indexing:** Embeds your workspace code (utilizing local `@xenova/transformers`) and indexes it in Astra DB for blazing-fast context retrieval.

## 🛠️ Prerequisites & Setup

Annotate.ai relies on **Groq** for high-speed LLM inference and DataStax **Astra DB** for Vector/RAG storage.

1. **Groq API Key**: 
   - Sign up at [GroqCloud](https://console.groq.com/) to get an API key. 
   - When you trigger your first AI command, the extension will prompt you to securely store this API key, or you can run `Annotate: Change API Keys`.
2. **Astra DB Credentials**:
   - Create a free serverless vector database at [DataStax Astra DB](https://astra.datastax.com/).
   - Generate an Application Token and locate your API Endpoint.
   - Run the command `Annotate: Set Astra DB Credentials` in VS Code and paste your credentials when prompted.

## 💻 Commands

Access these commands through the VS Code Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux):

### AI Coding & Review
* `Annotate: Add AI Comment`: Annotate the currently selected code block.
* `Annotate: Annotate Entire File`: Generate documentation/comments for the entire active file.
* `Annotate: Toggle Hover Explainer`: Toggle the inline AI code explanation on hover.
* `Annotate: Show Changes`: Diff view for recent changes.
* `Annotate: Generate README`: Auto-generate a README for the project.
* `Annotate: AI Code Review`: Analyze local changes and provide a comprehensive AI review.

### Git & Source Control
* `Annotate: Generate Commit Message`: Auto-generate a commit message for staged changes based on historical repo styles (RAG).
* `Annotate: Generate PR Description`: Generate a professional Markdown PR description for uncommitted/staged changes.
* `Annotate: Toggle Git Blame`: Toggle inline Git blame annotations (`$(git-commit) Author, time ago, summary`).
* `Annotate: Copy Commit Hash`: Copy the commit hash from the Git blame lens.
* `Annotate: Show File At Commit`: View the file exactly as it was at a specific commit.

### Workspace & Indexing (RAG)
* `Annotate: Index Workspace for RAG`: Embed and store your workspace code in Astra DB to give the AI context about your project.
* `Annotate: Index Commit History for RAG`: Parse and store the last 50 commits to learn your commit message style.
* `Annotate: Set Astra DB Credentials`: Configure the Astra DB connection.
* `Annotate: Change API Keys`: Update or clear your Groq API key securely.

## ⚙️ Architecture & Tech Stack

- **Extension API:** Visual Studio Code Extension API (`^1.110.0`)
- **Language Models:** Groq (`llama-3.3-70b-versatile`) for extremely fast generative logic.
- **RAG / Vector Database:** DataStax Astra DB (`@datastax/astra-db-ts`) for storing chunked code and commit hashes.
- **Local Embeddings:** HuggingFace Transformers (`@xenova/transformers`) running locally in Node.js to generate vector embeddings.

## 🏗️ Building from Source

To build and run this extension locally:

1. Clone the repository:
   ```bash
   git clone https://github.com/FrankC7/Annotate.ai.git
   cd Annotate.ai
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Compile the extension (or run the watch task):
   ```bash
   npm run compile
   # or
   npm run watch
   ```
4. Press `F5` in VS Code to open a new window with the extension loaded.
