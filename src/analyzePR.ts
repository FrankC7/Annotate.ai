import { getPassword } from "cross-keychain";
import { Octokit } from "@octokit/rest";
import Groq from "groq-sdk";
import * as dotenv from "dotenv";

// 1. Load Environment Variables (Ensure your .env only contains GROQ_API_KEY)
dotenv.config();

// 2. Fetch GitHub Token from OS Keychain
const githubToken = await getPassword("iclib-app", "github-token");

// DIAGNOSTIC: Confirm the token is loading as expected
if (githubToken) {
  console.log(`DEBUG: Token loaded. Starts with: "${githubToken.substring(0, 4)}" | Length: ${githubToken.length}`);
} else {
  console.error("❌ Error: GitHub token not found in system keychain.");
  console.log("👉 Run: npx cross-keychain set iclib-app github-token YOUR_GITHUB_TOKEN");
  process.exit(1);
}

// 3. Initialize Clients
const octokit = new Octokit({ auth: githubToken });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Analyzes a specific Pull Request using GitHub and Groq APIs
 */
async function analyzeIclibPR(prNumber: number) {
  const owner = "blueskysolarracing";
  const repo = "iclib";

  console.log(`\n🚀 Starting analysis for ${owner}/${repo} PR #${prNumber}...`);

  try {
    // --- STEP 1: Fetch PR Metadata and Diff ---
    console.log("📂 Fetching PR details and code changes...");
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    const { data: diff } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      headers: { accept: "application/vnd.github.diff" },
    }) as any;

    // --- STEP 2: Fetch Repository Context ---
    console.log("📖 Reading project README and file structure...");
    const { data: readmeFile } = await octokit.repos.getReadme({ owner, repo });
    const readme = Buffer.from(readmeFile.content, 'base64').toString();

    const { data: tree } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: pr.base.sha, 
      recursive: "true",
    });

    const filePaths = tree.tree.map(file => file.path).join(", ");

    // --- STEP 3: Construct AI Prompt ---
    console.log("🧠 Constructing analysis prompt...");
    const prompt = `
      You are a Senior Embedded Systems Engineer reviewing a PR for 'iclib'.
      
      PROJECT CONTEXT:
      This is a library for a solar racing team.
      README Summary: ${readme.slice(0, 800)}...
      
      PROJECT STRUCTURE:
      ${filePaths.slice(0, 1000)}...

      PULL REQUEST DIFF:
      ${diff.slice(0, 5000)}

      TASK:
      Summarize these changes. Specifically:
      1. What is the technical intent of this PR?
      2. How does this impact existing hardware drivers or communication protocols in the repo?
      3. Are there any potential logic bugs or type safety issues (TypeScript)?
    `;

    // --- STEP 4: Get AI Analysis ---
    console.log("⚡ Sending to Groq for high-speed analysis...");
    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile",
    });

    console.log("\n" + "=".repeat(30));
    console.log("📊 PR ANALYSIS SUMMARY");
    console.log("=".repeat(30));
    console.log(chatCompletion.choices[0].message.content);
    console.log("=".repeat(30));

  } catch (error: any) {
    if (error.status === 401) {
      console.error("❌ Error: Unauthorized. GitHub rejected the token. Check keychain formatting.");
    } else if (error.status === 404) {
      console.error(`❌ Error: PR #${prNumber} not found in ${owner}/${repo}.`);
    } else {
      console.error("❌ An unexpected error occurred:", error.message);
    }
  }
}

// --- EXECUTION ---
// Testing with PR #11 (Recent) instead of #1 (Very old/closed)
const TARGET_PR = 11; 
analyzeIclibPR(TARGET_PR);