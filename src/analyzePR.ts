import { Octokit } from "@octokit/rest";
import * as dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import readline from "readline";

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function getInputOrEnv(envVar: string, promptText: string): Promise<string> {
  const envValue = process.env[envVar]?.replace(/['"\s]+/g, '').trim();
  if (envValue) {
    console.log(`✅ Using ${envVar} from environment`);
    return envValue;
  }
  return prompt(promptText);
}

let NAMESPACE = process.env.MOORCHEH_NAMESPACE?.replace(/['"\s]+/g, '').trim();
let REPO_OWNER = process.env.GITHUB_OWNER?.trim();
let REPO_NAME = process.env.GITHUB_REPO?.trim();
let GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();

const CACHE_FILE = path.join(process.cwd(), ".moorcheh-cache.json");

async function setup() {
  console.log("🔧 AnalyzePR Setup\n");

  const moorchKey = await prompt("Moorcheh API Key: ");
  if (!moorchKey) {
    console.error("❌ Error: Moorcheh API key is required.");
    process.exit(1);
  }

  console.log("\nPress Enter to use environment variables or enter new values.\n");

  GITHUB_TOKEN = await getInputOrEnv("GITHUB_TOKEN", "GitHub Token (ghp_...): ");
  if (!GITHUB_TOKEN) {
    console.error("❌ Error: GitHub token is required.");
    process.exit(1);
  }

  REPO_OWNER = await getInputOrEnv("GITHUB_OWNER", "Repository Owner (e.g., blueskysolarracing): ");
  REPO_NAME = await getInputOrEnv("GITHUB_REPO", "Repository Name (e.g., iclib): ");
  
  const prInput = await getInputOrEnv("GITHUB_PR", "PR Number (e.g., 11): ");
  const prNumber = parseInt(prInput, 10);
  
  NAMESPACE = await getInputOrEnv("MOORCHEH_NAMESPACE", "Moorcheh Namespace (e.g., iclib-repo-context): ");

  if (!REPO_OWNER || !REPO_NAME || !prNumber || !NAMESPACE) {
    console.error("❌ Error: All fields are required.");
    process.exit(1);
  }

  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  
  console.log("\n" + "=".repeat(50));
  console.log("📋 Configuration Summary:");
  console.log(`  Owner: ${REPO_OWNER}`);
  console.log(`  Repo: ${REPO_NAME}`);
  console.log(`  PR: #${prNumber}`);
  console.log(`  Namespace: ${NAMESPACE}`);
  console.log("=".repeat(50) + "\n");

  return { octokit, moorchKey, prNumber, owner: REPO_OWNER, repo: REPO_NAME };
}

/**
 * STEP A: Check if namespace exists, create if not
 */
async function ensureNamespace(moorchKey: string, nsName: string) {
  console.log(`\n🛠️ Checking Moorcheh Namespace: ${nsName}...`);
  
  try {
    // Try to create first - API returns "already exists" if it does
    const createResponse = await fetch("https://api.moorcheh.ai/v1/namespaces", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": moorchKey },
      body: JSON.stringify({ namespace_name: nsName, type: "text" })
    });
    
    const createData = await createResponse.json() as any;
    console.log(`📬 Namespace response: ${createResponse.status}`, createData);
    
    if (createResponse.ok) {
      console.log("✅ New namespace created.");
      return true;
    }
    
    if (createData.message?.includes("already exists")) {
      console.log(`✅ Namespace '${nsName}' already exists. Will update files.`);
      return true;
    }
    
    console.error("❌ Namespace setup failed:", createData);
    return false;
  } catch (err: any) {
    console.error("❌ Network error during namespace check:", err.message);
    return false;
  }
}

/**
 * STEP B: Sync the Entire iclib PR Branch Context to Moorcheh
 * THE UPGRADE: This now fetches the code specifically from the unmerged PR branch!
 */
async function syncRepositoryContext(octokit: Octokit, moorchKey: string, nsName: string, owner: string, repo: string, prNumber: number) {
  console.log(`\n📚 Syncing PR #${prNumber} context to Moorcheh...`);
  try {
    // 1. Fetch the PR details to get the exact commit hash of the incoming branch
    let prInfo;
    try {
      prInfo = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
    } catch (err: any) {
      if (err.status === 404) {
        console.error(`❌ Error: PR #${prNumber} not found in ${owner}/${repo}`);
        console.log("👉 Possible causes:");
        console.log("   - Wrong repository owner/name");
        console.log("   - PR number doesn't exist");
        console.log("   - Repository is private (need appropriate token scope)");
        return;
      }
      throw err;
    }
    
    const prCommitSha = prInfo.data.head.sha;

    // 2. Fetch the file tree using the PR's commit SHA
    const { data: treeData } = await octokit.git.getTree({
      owner, repo, tree_sha: prCommitSha, recursive: "1" 
    });

    const allowedExts = [
      '.c', '.h', '.cpp', '.hpp', 
      '.ts', '.js', '.py', '.md', 
      '.txt', '.json', '.yaml', '.yml', 
      '.ld', '.s', '.toml', '.ini'
    ];
    
    const sourceFiles = treeData.tree.filter(f => {
      if (f.type !== "blob" || !f.path) return false;
      const lowerPath = f.path.toLowerCase();
      return allowedExts.some(ext => lowerPath.endsWith(ext));
    });

    if (sourceFiles.length === 0) {
      console.log("⚠️ No matching source files found in this PR's tree.");
      return;
    }

    // --- CACHING LOGIC ---
    const cacheKey = `${owner}-${repo}-${prNumber}`;
    const cacheFile = path.join(process.cwd(), `.moorcheh-cache-${cacheKey}.json`);
    let cache: Record<string, string> = {};
    try {
      const cacheData = await fs.readFile(cacheFile, "utf-8");
      cache = JSON.parse(cacheData);
    } catch (e) {
      console.log("🆕 No local cache found. Performing initial full sync...");
    }

    // Compare PR files against our cache
    const filesToUpload = sourceFiles.filter(file => cache[file.path] !== file.sha);

    if (filesToUpload.length === 0) {
      console.log(`⚡ All ${sourceFiles.length} files are up-to-date for this PR. Skipping upload.`);
      return; 
    }

    console.log(`Found ${filesToUpload.length} new/modified files in this PR. Uploading to namespace...`);

    let successCount = 0;
    for (const file of filesToUpload) {
      const { data: blob } = await octokit.git.getBlob({ owner, repo, file_sha: file.sha! });
      let content = Buffer.from(blob.content, 'base64').toString('utf-8');

      // Handle empty files safely
      if (!content.trim()) {
        content = `# Empty file: ${file.path} (Used for structural purposes)`;
      }

      const response = await fetch(`https://api.moorcheh.ai/v1/namespaces/${nsName}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": moorchKey },
        body: JSON.stringify({
          documents: [
            {
              id: file.path,       
              text: content,       
              metadata: { filename: file.path, source: "github_sync_pr" }
            }
          ]
        })
      });

      if (response.ok) {
        successCount++;
        cache[file.path] = file.sha!; 
        process.stdout.write("."); 
      } else {
        console.warn(`\n⚠️ Failed to upload ${file.path}`);
      }
    }
    
    // Save updated cache
    await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2));

    console.log(`\n✅ Successfully synced ${successCount}/${filesToUpload.length} files into context.`);
    console.log("⏳ Waiting 5 seconds for Moorcheh to index the PR codebase...");
    await new Promise(resolve => setTimeout(resolve, 5000));

  } catch (error: any) {
    console.error(`\n⚠️ Sync failed: ${error.message}`);
  }
}

/**
 * STEP C: Run Analysis using Moorcheh's Native Answer Endpoint
 */
async function analyzePR(octokit: Octokit, moorchKey: string, nsName: string, owner: string, repo: string, prNumber: number) {
  try {
    const ready = await ensureNamespace(moorchKey, nsName);
    if (!ready) return;

    await syncRepositoryContext(octokit, moorchKey, nsName, owner, repo, prNumber);

    console.log(`\n📂 Fetching Diff for ${repo} PR #${prNumber}...`);
    let pr, diff;
    try {
      pr = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
      diff = await octokit.pulls.get({
        owner, repo, pull_number: prNumber,
        headers: { accept: "application/vnd.github.diff" },
      }) as any;
    } catch (err: any) {
      if (err.status === 404) {
        console.error(`❌ Error: Could not fetch PR #${prNumber} from ${owner}/${repo}`);
        console.log("👉 Check that the PR exists and you have access to the repository.");
        return;
      }
      throw err;
    }

    const prompt = `
      You are a Senior Software Engineer reviewing a Pull Request for '${repo}'.
      Repository: ${owner}/${repo}
      PR Title: ${pr.data.title}
      PR Body: ${pr.data.body}

      PULL REQUEST DIFF:
      ${(diff.data as string).slice(0, 5000)}

      CRITICAL INSTRUCTION:
      Before evaluating the diff, you MUST search your uploaded namespace documents to understand the broader '${repo}' architecture and any files interacting with this code.

      Please provide a comprehensive code review in Markdown format covering:
      1. 🎯 Executive Summary: What does this PR change?
      2. 🏗️ Architectural Impact: How does this affect the rest of the codebase?
      3. ⚠️ Safety & Dependencies: Identify any logic flaws, missing dependencies, or memory issues.
      4. 📝 Line-by-Line Feedback: Specific, actionable recommendations.
    `;

    const url = "https://api.moorcheh.ai/v1/answer";
    console.log(`⚡ Sending code and context to Moorcheh Answer API...`);
      
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": moorchKey },
      body: JSON.stringify({ namespace: nsName, query: prompt })
    });

    const result = await response.json() as any;

    if (response.ok) {
      console.log("\n" + "=".repeat(60));
      console.log("📊 SENIOR ENGINEER PR ANALYSIS");
      console.log("=".repeat(60));
      
      const finalAnalysis = result.answer || result.text || result.choices?.[0]?.message?.content || JSON.stringify(result, null, 2);
      console.log(finalAnalysis);
      
      console.log("=".repeat(60));
    } else {
      console.error("❌ API Request Failed:", JSON.stringify(result, null, 2));
    }

  } catch (error: any) {
    console.error("❌ System Error:", error.message);
  }
}

async function main() {
  const { octokit, moorchKey, prNumber, owner, repo } = await setup();

  await analyzePR(octokit, moorchKey, NAMESPACE || "my-repo-context", owner, repo, prNumber);
  rl.close();
}

main();