import * as dotenv from "dotenv";
import { execSync } from "child_process";
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

async function setup() {
  console.log("🔧 WhoWrotethis Setup\n");

  const moorchKey = await prompt("Moorcheh API Key: ");
  if (!moorchKey) {
    console.error("❌ Error: Moorcheh API key is required.");
    process.exit(1);
  }

  console.log("\nPress Enter to use environment variables or enter new values.\n");

  const namespace = await getInputOrEnv("MOORCHEH_NAMESPACE", "Moorcheh Namespace (e.g., iclib-repo-context): ");
  const repoPath = await getInputOrEnv("REPO_PATH", "Local Repository Path (e.g., C:/path/to/repo): ");

  if (!namespace || !repoPath) {
    console.error("❌ Error: Moorcheh namespace and repo path are required.");
    process.exit(1);
  }

  console.log("\n" + "=".repeat(50));
  console.log("📋 Configuration Summary:");
  console.log(`  Namespace: ${namespace}`);
  console.log(`  Repo Path: ${repoPath}`);
  console.log("=".repeat(50) + "\n");

  return { moorchKey, namespace, repoPath };
}

async function runAutomatedInvestigation(codeChunk: string, searchAnchor: string, moorchKey: string, namespace: string, repoPath: string) {
  try {
    const runGit = (cmd: string) => execSync(cmd, { cwd: repoPath, encoding: "utf-8" });

    console.log(`\n📡 STEP 1: Syncing Git at ${repoPath}...`);
    try {
      runGit("git fetch --all");
      
      const branchName = "michael/workflow";
      try {
        runGit(`git checkout ${branchName}`);
        console.log(`✅ Successfully switched to: ${runGit("git rev-parse --abbrev-ref HEAD").trim()}`);
      } catch {
        console.log(`⚠️ Branch '${branchName}' not found. Continuing with current branch...`);
        console.log(`📍 Current branch: ${runGit("git rev-parse --abbrev-ref HEAD").trim()}`);
      }
    } catch (e: any) {
      console.warn(`⚠️ Git Error: ${e.message}. Continuing anyway...`);
    }

    // --- STEP 2: FIND FILE USING GIT GREP (more reliable than Moorcheh) ---
    console.log("\n🔍 STEP 2: Searching for file containing code...");
    
    let filePath = "";
    
    try {
      const grepCmd = `git grep -l "${searchAnchor.replace(/"/g, '\\"')}" -- "*.py"`;
      const grepOutput = runGit(grepCmd).trim();
      
      if (grepOutput) {
        const foundFiles = grepOutput.split("\n").filter(f => f.trim());
        filePath = foundFiles[0];
        console.log(`✅ Found via git grep: ${filePath}`);
      }
    } catch (grepErr) {
      console.log("⚠️ Git grep failed. Trying Moorcheh...");
    }
    
    // Fallback to Moorcheh if git grep didn't find it
    if (!filePath) {
      console.log("🤖 Asking Moorcheh to locate the file...");
      const searchPrompt = `
        Search all files in the codebase (including test files in directories like 'tests/', 'test/', '__tests__/', 'spec/') for: "${searchAnchor}"
        
        Rules:
        - Search in both source and test directories
        - Return ONLY the file path (e.g., "iclib/nau7802_test.py" or "tests/test_nau7802.py")
        - Do NOT include any explanation or other text
        - If not found, respond with exactly: NOT_FOUND
      `;

      const searchRes = await fetch("https://api.moorcheh.ai/v1/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": moorchKey },
        body: JSON.stringify({ namespace: namespace, query: searchPrompt })
      });

      const searchData = await searchRes.json() as any;
      filePath = searchData.answer || searchData.text || searchData.response || searchData.content || "";

      if (typeof filePath === 'object' && filePath !== null) {
        filePath = JSON.stringify(filePath);
      }
      
      filePath = filePath.trim().replace(/^["']|["']$/g, '');

      console.log(`🔍 Raw response from Moorcheh:`, filePath);

      const pathMatch = filePath.match(/(?:iclib|tests?|test|__tests__|spec|src|example)[\\/][^\s*:"'<>|]+\.py/);
      if (pathMatch) {
        filePath = pathMatch[0];
      }

      const isNotFound = filePath.toUpperCase().endsWith("NOT_FOUND") || 
                         filePath.toUpperCase().includes("COULD NOT FIND") ||
                         filePath.toUpperCase().includes("CANNOT FIND") ||
                         (!filePath.includes("/") && !filePath.includes("\\") && filePath.split('\n').length > 3);

      if (isNotFound || !filePath) {
        console.log("❌ Could not locate the code in the repository.");
        console.log("👉 Make sure the code exists in the local repo!");
        return;
      }
    }

    filePath = filePath.replace(/^["']|["']$/g, '').trim();
    
    console.log(`✅ File pinpointed: ${filePath}`);
    console.log(`\n📜 STEP 3: Running 'git blame'...`);

    let blameText = "";
    const blameCmd = `git blame -w "${filePath}"`;
    try {
      blameText = runGit(blameCmd);
      console.log(`📊 Blame output lines: ${blameText.split('\n').length}`);
    } catch (e) {
      const altPath = filePath.startsWith("iclib/") ? filePath.replace("iclib/", "") : `iclib/${filePath}`;
      console.log(`⚠️ Path mismatch. Retrying with: ${altPath}`);
      blameText = runGit(`git blame -w "${altPath}"`);
      filePath = altPath;
    }

    console.log(`🔎 Searching for lines matching: ${searchAnchor}`);
    
    let blameToAnalyze = blameText;
    
    try {
      const fileContent = runGit(`git show HEAD:"${filePath}"`);
      const lines = fileContent.split("\n");
      const matchingLineNums: number[] = [];
      
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(searchAnchor) || lines[i].match(new RegExp(searchAnchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))) {
          matchingLineNums.push(i + 1);
        }
      }
      
      if (matchingLineNums.length > 0) {
        console.log(`📍 Found matching lines: ${matchingLineNums.join(", ")}`);
        const startLine = Math.max(1, Math.min(...matchingLineNums) - 2);
        const endLine = Math.max(...matchingLineNums) + 5;
        console.log(`📍 Blaming lines ${startLine}-${endLine}...`);
        blameToAnalyze = runGit(`git blame -w -L ${startLine},${endLine} "${filePath}"`);
      } else {
        console.log("⚠️ Could not find specific lines in file, using full blame...");
      }
    } catch (e: any) {
      console.log(`⚠️ Could not search file content: ${e.message}, using full blame...`);
    }

    // --- STEP 4: AI AUTHORSHIP ANALYSIS ---
    console.log(`\n🧠 STEP 4: Identifying author with AI...`);
    const analysisPrompt = `
      You are an engineering lead. Based on this 'git blame' output for '${filePath}':
      ${blameToAnalyze.slice(0, 15000)}

      Identify the author who wrote this specific block (look for matching lines):
      ${codeChunk}

      Find the line numbers in the blame output that match the code above and extract:
      - Author Name
      - Date of Push  
      - Commit Hash
      - Commit Message

      Return in this exact format:
      **Author Name:** <name>
      **Date:** <date>
      **Commit Hash:** <hash>
      **Commit Message:** <message>
    `;

    const analysisRes = await fetch("https://api.moorcheh.ai/v1/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": moorchKey },
      body: JSON.stringify({ namespace: namespace, query: analysisPrompt })
    });

    const analysisData = await analysisRes.json() as any;
    const answer = analysisData.answer || analysisData.text || analysisData.response || analysisData.content || "No response received";
    
    console.log("\n" + "=".repeat(60));
    console.log(answer);
    console.log("=".repeat(60));

  } catch (error: any) {
    console.error(`\n❌ Fatal System Error: ${error.message}`);
  }
}

async function main() {
  const { moorchKey, namespace, repoPath } = await setup();
  
  console.log("\n🔍 WhoWrotethis - Find out who wrote specific code\n");
  console.log("Option 1: Enter code directly (one line at a time, empty line to finish)");
  console.log("Option 2: Provide code as command-line argument");
  console.log("Option 3: Provide path to a file containing the code\n");
  
  let codeChunk = "";
  let searchAnchor = "";
  
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const filePath = args[0];
    try {
      const fs = await import('fs/promises');
      codeChunk = await fs.readFile(filePath, 'utf-8');
      const lines = codeChunk.split('\n');
      searchAnchor = lines[0].trim();
      console.log(`✅ Loaded code from: ${filePath}`);
    } catch (e) {
      codeChunk = args.join(" ");
      searchAnchor = codeChunk.split('\n')[0].trim();
      console.log("✅ Using code from command-line argument");
    }
  } else {
    console.log("\nPaste your code below (press Enter on an empty line when done):\n");
    
    const lines: string[] = [];
    
    while (true) {
      const line = await prompt("");
      if (line.trim() === "") break;
      lines.push(line);
    }
    
    if (lines.length === 0) {
      console.log("❌ No code provided. Exiting.");
      rl.close();
      return;
    }
    
    codeChunk = lines.join("\n");
    searchAnchor = lines[0].trim();
  }
  
  console.log(`\n📝 Code to check:\n${codeChunk}\n`);
  
  await runAutomatedInvestigation(codeChunk, searchAnchor, moorchKey, namespace, repoPath);
  rl.close();
}

main();