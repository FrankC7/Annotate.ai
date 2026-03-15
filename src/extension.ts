import * as vscode from "vscode";
import * as path from "path";
import Groq from "groq-sdk";
import * as Diff from "diff";
import * as cp from "child_process";
import { promisify } from "util";
import { FileHistoryViewProvider } from "./fileHistoryView.js";

const exec = promisify(cp.exec);

// --- STATE MANAGEMENT & CACHING ---
let isHoverEnabled = false;
let isBlameEnabled = false;
let groq: Groq | undefined;
let extensionContext: vscode.ExtensionContext;

const addedLineDecoration = vscode.window.createTextEditorDecorationType({
	backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
	isWholeLine: true,
});

const removedLineDecoration = vscode.window.createTextEditorDecorationType({
	backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
	isWholeLine: true,
});

let isHighlighting = false;

// Cache to prevent duplicate API calls (Production-Ready Feature)
const aiHoverCache = new Map<string, string>();
const blameEventEmitter = new vscode.EventEmitter<void>();

// --- HOVER PROVIDER WITH ABORT CONTROLLER & CACHE ---

class AIHoverProvider implements vscode.HoverProvider {
	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken
	): Promise<vscode.Hover | null> {
		if (!isHoverEnabled) return null;
		const lineText = document.lineAt(position.line).text.trim();
		if (!lineText || lineText.length < 3) return null;

		const cacheKey = `${document.uri.fsPath}:${position.line}:${lineText}`;

		// 1. Check Cache
		if (aiHoverCache.has(cacheKey)) {
			const cachedMarkdown = new vscode.MarkdownString(
				aiHoverCache.get(cacheKey)
			);
			cachedMarkdown.isTrusted = true;
			return new vscode.Hover(cachedMarkdown);
		}

		// 2. Wait for intentional hover
		await new Promise((resolve) => setTimeout(resolve, 600));
		if (token.isCancellationRequested) return null;

		const groqInstance = await ensureGroq(extensionContext);
		if (!groqInstance) return null;

		// 3. Create AbortController for cancellable requests
		const abortController = new AbortController();
		const tokenListener = token.onCancellationRequested(() => {
			abortController.abort();
		});

		try {
			const res = await groqInstance.chat.completions.create(
				{
					model: "llama-3.3-70b-versatile",
					messages: [
						{
							role: "system",
							content:
								"You are a coding assistant. Provide a single-sentence, concise explanation of the logic in this line of code.",
						},
						{ role: "user", content: `Explain this line: ${lineText}` },
					],
				},
				{ signal: abortController.signal as any }
			);

			const explanation =
				res.choices[0].message.content?.trim() || "No explanation available.";

			const markdownContent = `**Annotate: AI Explanation**\n\n${explanation}`;
			aiHoverCache.set(cacheKey, markdownContent); // Save to cache

			const markdown = new vscode.MarkdownString(markdownContent);
			markdown.isTrusted = true;

			return new vscode.Hover(markdown);
		} catch (e: any) {
			if (e.name === "AbortError") {
				console.log("Hover request cancelled by user movement.");
				return null;
			}
			console.error("Hover AI Error:", e);
			return null;
		} finally {
			tokenListener.dispose();
		}
	}
}

// --- HELPER CLASSES & UTILS ---

export class PreviewProvider implements vscode.TextDocumentContentProvider {
	private _content = new Map<string, string>();

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this._content.get(uri.path) || "";
	}

	setSnapshot(uri: vscode.Uri, text: string) {
		this._content.set(uri.path, text);
	}
}

function formatRelativeTime(unixTimestamp: string): string {
	const time = parseInt(unixTimestamp, 10) * 1000;
	const now = Date.now();
	const diff = now - time;
	const days = Math.floor(diff / (1000 * 60 * 60 * 24));

	if (days > 365) return `${Math.floor(days / 365)}y ago`;
	if (days > 30) return `${Math.floor(days / 30)}mo ago`;
	if (days > 0) return `${days}d ago`;
	return "recently";
}

function getCommentStyle(languageId: string) {
	const mapping: Record<
		string,
		{ type: 'line'; prefix: string } | { type: 'block'; start: string; end: string }
	> = {
		javascript: { type: 'line', prefix: '// ' },
		typescript: { type: 'line', prefix: '// ' },
		typescriptreact: { type: 'line', prefix: '// ' },
		javascriptreact: { type: 'line', prefix: '// ' },
		python: { type: 'line', prefix: '# ' },
		shellscript: { type: 'line', prefix: '# ' },
		ruby: { type: 'line', prefix: '# ' },
		go: { type: 'line', prefix: '// ' },
		rust: { type: 'line', prefix: '// ' },
		java: { type: 'line', prefix: '// ' },
		php: { type: 'line', prefix: '// ' },
		c: { type: 'line', prefix: '// ' },
		cpp: { type: 'line', prefix: '// ' },
		css: { type: 'block', start: '/*', end: '*/' },
		scss: { type: 'block', start: '/*', end: '*/' },
		html: { type: 'block', start: '<!--', end: '-->' },
	};
	return mapping[languageId] ?? { type: 'block', start: '/*', end: '*/' };
}

function formatAsComment(text: string, languageId: string): string {
	const style = getCommentStyle(languageId);
	let cleaned = text.trim();
	if (
		(cleaned.startsWith('"') && cleaned.endsWith('"')) ||
		(cleaned.startsWith('“') && cleaned.endsWith('”'))
	) {
		cleaned = cleaned.slice(1, -1).trim();
	}
	if (!cleaned) return '';

	if (style.type === 'block') {
		const safeText = cleaned.replace(/\*\//g, '*\\/');
		return `${style.start} ${safeText} ${style.end}\n`;
	}

	return (
		cleaned
			.split(/\r?\n/)
			.map((line) => `${style.prefix}${line}`)
			.join('\n') + '\n'
	);
}

// --- GIT BLAME CODELENS PROVIDER ---

class GitBlameCodeLensProvider implements vscode.CodeLensProvider {
	public get onDidChangeCodeLenses(): vscode.Event<void> {
		return blameEventEmitter.event;
	}

	async provideCodeLenses(
		document: vscode.TextDocument,
		token: vscode.CancellationToken
	): Promise<vscode.CodeLens[]> {
		if (!isBlameEnabled || document.uri.scheme !== "file") {
			return [];
		}

		const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
		if (!workspaceFolder) return [];

		try {
			const { stdout } = await exec(
				`git blame --line-porcelain "${document.uri.fsPath}"`,
				{ cwd: workspaceFolder.uri.fsPath }
			);
			return this.parseBlameOutput(stdout);
		} catch (error) {
			return [];
		}
	}

	private parseBlameOutput(stdout: string): vscode.CodeLens[] {
		const commitCache = new Map<
			string,
			{ committer: string; time: string; summary: string }
		>();
		const lines = stdout.split("\n");
		const lineData: {
			hash: string;
			committer: string;
			time: string;
			summary: string;
			finalLine: number;
		}[] = [];

		let currentHash = "";
		let finalLine = 0;

		for (const line of lines) {
			const hashMatch = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
			if (hashMatch) {
				currentHash = hashMatch[1];
				finalLine = parseInt(hashMatch[2], 10) - 1;
				if (!commitCache.has(currentHash)) {
					commitCache.set(currentHash, {
						committer: "Unknown",
						time: "",
						summary: "No summary",
					});
				}
			} else if (line.startsWith("committer ")) {
				commitCache.get(currentHash)!.committer = line.substring(10);
			} else if (line.startsWith("committer-time ")) {
				commitCache.get(currentHash)!.time = formatRelativeTime(
					line.substring(15)
				);
			} else if (line.startsWith("summary ")) {
				commitCache.get(currentHash)!.summary = line.substring(8);
			} else if (line.startsWith("\t")) {
				const data = commitCache.get(currentHash)!;
				lineData.push({ hash: currentHash, ...data, finalLine });
			}
		}

		const lenses: vscode.CodeLens[] = [];
		if (lineData.length === 0) return lenses;
		lineData.sort((a, b) => a.finalLine - b.finalLine);

		let blockStartLine = lineData[0].finalLine;
		let lastHash = lineData[0].hash;
		let lastCommitter = lineData[0].committer;
		let lastTime = lineData[0].time;
		let lastSummary = lineData[0].summary;

		for (let i = 1; i <= lineData.length; i++) {
			const data = lineData[i];
			if (!data || data.hash !== lastHash) {
				const range = new vscode.Range(blockStartLine, 0, blockStartLine, 0);
				const isUncommitted = lastHash.startsWith("000000000000");
				const title = isUncommitted
					? `Uncommitted changes`
					: `$(git-commit) ${lastCommitter}, ${lastTime}, ${lastSummary}`;
				lenses.push(
					new vscode.CodeLens(range, {
						title,
						command: isUncommitted ? "" : "annotate-ai.copyCommitHash",
						arguments: [lastHash],
						tooltip: isUncommitted ? "Not committed" : `Copy: ${lastHash}`,
					})
				);
				if (data) {
					blockStartLine = data.finalLine;
					lastHash = data.hash;
					lastCommitter = data.committer;
					lastTime = data.time;
					lastSummary = data.summary;
				}
			}
		}
		return lenses;
	}
}

// --- GLOBALS & CONFIG ---

async function ensureGroq(
	context: vscode.ExtensionContext
): Promise<Groq | undefined> {
	if (groq) return groq;
	let apiKey = await context.secrets.get("groqApiKey");
	if (!apiKey) {
		const input = await vscode.window.showInputBox({
			prompt: "Enter your Groq API Key",
			password: true,
			placeHolder: "gsk_...",
		});
		if (input) {
			await context.secrets.store("groqApiKey", input);
			apiKey = input;
		}
	}
	if (apiKey) groq = new Groq({ apiKey });
	return groq;
}

async function getGitRepository(): Promise<any> {
	const gitExtension = vscode.extensions.getExtension<any>("vscode.git");
	if (!gitExtension) return null;
	const api = (
		gitExtension.isActive ? gitExtension.exports : await gitExtension.activate()
	).getAPI(1);
	return api?.repositories[0] ?? null;
}

async function openMarkdownPreview(title: string, content: string) {
	const document = await vscode.workspace.openTextDocument({
		language: "markdown",
		content: content,
	});
	await vscode.window.showTextDocument(document, { preview: false });
}

// --- ACTIVATION ---

export function activate(context: vscode.ExtensionContext) {
	extensionContext = context;
	const provider = new PreviewProvider();

	const fileHistoryProvider = new FileHistoryViewProvider(context.extensionUri);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			FileHistoryViewProvider.viewType,
			fileHistoryProvider
		)
	);

	vscode.window.onDidChangeActiveTextEditor((editor) => {
		fileHistoryProvider.update();
		if (editor && isHighlighting) {
			editor.setDecorations(addedLineDecoration, []);
			editor.setDecorations(removedLineDecoration, []);
			isHighlighting = false;
		}
	});

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			"annotate-ai-preview",
			provider
		),
		vscode.languages.registerCodeLensProvider(
			{ scheme: "file" },
			new GitBlameCodeLensProvider()
		),
		vscode.languages.registerHoverProvider(
			{ scheme: "file" },
			new AIHoverProvider()
		)
	);

	vscode.workspace.onDidChangeTextDocument(() => {
		if (isBlameEnabled) blameEventEmitter.fire();
		const editor = vscode.window.activeTextEditor;
		if (editor && isHighlighting) {
			editor.setDecorations(addedLineDecoration, []);
			editor.setDecorations(removedLineDecoration, []);
			isHighlighting = false;
		}
	});

	// --- COMMANDS ---

	context.subscriptions.push(
		vscode.commands.registerCommand("annotate-ai.toggleHoverExplainer", () => {
			isHoverEnabled = !isHoverEnabled;
			vscode.window.showInformationMessage(
				`AI Hover Explainer: ${isHoverEnabled ? "ON" : "OFF"}`
			);
		}),

		vscode.commands.registerCommand("annotate-ai.changeApiKeys", async () => {
			await context.secrets.delete("groqApiKey");
			groq = undefined;
			vscode.window.showInformationMessage("API Keys cleared.");
		}),

		vscode.commands.registerCommand("annotate-ai.toggleGitBlame", () => {
			isBlameEnabled = !isBlameEnabled;
			blameEventEmitter.fire();
		}),

		vscode.commands.registerCommand(
			"annotate-ai.copyCommitHash",
			async (hash: string) => {
				await vscode.env.clipboard.writeText(hash);
				vscode.window.showInformationMessage(
					`Hash copied: ${hash.slice(0, 7)}`
				);
			}
		),

		vscode.commands.registerCommand(
			"annotate-ai.generateCommitMessage",
			async () => {
				const repo = await getGitRepository();
				if (!repo) return;
				const groqInstance = await ensureGroq(context);
				if (!groqInstance) return;

				try {
					const { stdout: diff } = await exec("git diff --staged", {
						cwd: repo.rootUri.fsPath,
					});
					if (!diff) {
						vscode.window.showWarningMessage("No staged changes found.");
						return;
					}
					const res = await groqInstance.chat.completions.create({
						model: "llama-3.3-70b-versatile",
						messages: [
							{
								role: "system",
								content: "Output only a raw conventional commit message.",
							},
							{ role: "user", content: `Diff: ${diff.slice(0, 10000)}` },
						],
					});
					repo.inputBox.value = res.choices[0].message.content!.trim();
				} catch (e: any) {
					vscode.window.showErrorMessage(e.message);
				}
			}
		),

		// NEW FEATURE: Generate PR Description
		vscode.commands.registerCommand(
			"annotate-ai.generatePRDescription",
			async () => {
				const repo = await getGitRepository();
				if (!repo) return;
				const groqInstance = await ensureGroq(context);
				if (!groqInstance) return;

				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Generating PR Description...",
					},
					async () => {
						try {
							// Try staged changes first, fallback to all uncommitted changes
							let { stdout: diff } = await exec("git diff --staged", {
								cwd: repo.rootUri.fsPath,
							});
							if (!diff) {
								const { stdout: uncommittedDiff } = await exec("git diff", {
									cwd: repo.rootUri.fsPath,
								});
								diff = uncommittedDiff;
							}

							if (!diff) {
								vscode.window.showWarningMessage("No changes to describe.");
								return;
							}

							const res = await groqInstance.chat.completions.create({
								model: "llama-3.3-70b-versatile",
								messages: [
									{
										role: "system",
										content: `You are a helpful engineering assistant. Create a highly professional Markdown Pull Request description based on the provided git diff.
                    Include:
                    1. 🎯 Summary of Changes
                    2. 🛠️ Technical Implementation details
                    3. ⚠️ Areas that need special attention during review
                    Format strictly in Markdown.`,
									},
									{ role: "user", content: `Diff: ${diff.slice(0, 15000)}` },
								],
							});

							const prDescription = res.choices[0].message.content!;
							await openMarkdownPreview("PR Description", prDescription);
						} catch (e: any) {
							vscode.window.showErrorMessage(
								`Failed to generate PR description: ${e.message}`
							);
						}
					}
				);
			}
		),

		// NEW FEATURE: AI Senior Engineer Code Review
		vscode.commands.registerCommand("annotate-ai.aiCodeReview", async () => {
			const repo = await getGitRepository();
			if (!repo) return;
			const groqInstance = await ensureGroq(context);
			if (!groqInstance) return;

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Analyzing Changes",
				},
				async () => {
					try {
						// Get all local changes (staged and unstaged)
						const { stdout: diff } = await exec("git diff HEAD", {
							cwd: repo.rootUri.fsPath,
						});

						if (!diff) {
							vscode.window.showWarningMessage(
								"No local changes found to review."
							);
							return;
						}

						const res = await groqInstance.chat.completions.create({
							model: "llama-3.3-70b-versatile",
							messages: [
								{
									role: "system",
									content: `You are a Senior Software Engineer conducting a thorough Code Review.
                  Review the following git diff and provide a detailed markdown report covering:
                  1. 🎯 Executive Summary: What does this code change do?
                  2. 🏗️ Architectural Impact: How might this affect other systems?
                  3. ⚠️ Safety & Bugs: Identify logic flaws, missing error handling, or memory issues.
                  4. 📝 Actionable Feedback: Specific line-by-line recommendations.
                  Be strict, constructive, and format beautifully in Markdown.`,
								},
								{ role: "user", content: `PULL REQUEST DIFF:\n${diff.slice(0, 15000)}` },
							],
						});

						const reviewOutput = res.choices[0].message.content!;
						await openMarkdownPreview("AI Code Review", reviewOutput);
					} catch (e: any) {
						vscode.window.showErrorMessage(
							`Code Review failed: ${e.message}`
						);
					}
				}
			);
		}),

		// NEW FEATURE: Show File at Commit
		vscode.commands.registerCommand(
			"annotate-ai.showFileAtCommit",
			async (hash: string, filePath: string) => {
				try {
					const workspaceFolder = vscode.workspace.getWorkspaceFolder(
						vscode.Uri.file(filePath)
					);
					if (!workspaceFolder) return;
					const cwd = workspaceFolder.uri.fsPath;

					// Find git root
					const { stdout: repoRoot } = await exec(
						"git rev-parse --show-toplevel",
						{ cwd }
					);

					// Find parent commit hash (to compare against)
					let parentHash = "";
					try {
						const { stdout: parentStdout } = await exec(
							`git log --pretty=%P -n 1 ${hash}`,
							{ cwd: repoRoot.trim() }
						);
						// If merge commit, %P returns multiple hashes. We just take the first one.
						parentHash = parentStdout.trim().split(" ")[0];
					} catch (e) {
						// Might be the first commit, handle gracefully later
					}

					// Get relative path using forward slashes for git
					const relativePath = path
						.relative(repoRoot.trim(), filePath)
						.replace(/\\/g, "/");

					// Get file content at EXACT commit
					const { stdout: currentContent } = await exec(
						`git show ${hash}:"${relativePath}"`,
						{ cwd: repoRoot.trim() }
					);

					const currentUri = vscode.Uri.parse(
						`annotate-ai-preview:/commit/${hash}/${path.basename(filePath)}`
					);
					provider.setSnapshot(currentUri, currentContent);

					// If there is a parent, get file content at PARENT commit
					if (parentHash) {
						try {
							const { stdout: parentContent } = await exec(
								`git show ${parentHash}:"${relativePath}"`,
								{ cwd: repoRoot.trim() }
							);
							
							const parentUri = vscode.Uri.parse(
								`annotate-ai-preview:/commit/${parentHash}/${path.basename(filePath)}`
							);
							provider.setSnapshot(parentUri, parentContent);

							// Open Diff View comparing parent -> current
							await vscode.commands.executeCommand(
								"vscode.diff",
								parentUri,
								currentUri,
								`${path.basename(filePath)} (Commit ${hash.slice(0, 7)})`,
								{ preview: true, viewColumn: vscode.ViewColumn.Beside }
							);
							return;
						} catch (e) {
							// If parent didn't have the file (e.g. it was newly added in this commit), fall back to standard view
						}
					}

					// Fallback: If no parent (first commit) or file didn't exist in parent, just show the file
					const doc = await vscode.workspace.openTextDocument(currentUri);
					try {
						const origDoc = await vscode.workspace.openTextDocument(
							vscode.Uri.file(filePath)
						);
						vscode.languages.setTextDocumentLanguage(doc, origDoc.languageId);
					} catch {}

					await vscode.window.showTextDocument(doc, {
						preview: true,
						viewColumn: vscode.ViewColumn.Beside,
					});
				} catch (e: any) {
					vscode.window.showErrorMessage(
						`Failed to load file at commit ${hash}: ${e.message}`
					);
				}
			}
		)
	);

	// RESTORED LEGACY COMMANDS
	context.subscriptions.push(
		// COMMAND 1: Annotate Selection
		vscode.commands.registerCommand('annotate-ai.annotateSelection', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;

			const selection = editor.selection;
			const selectedText = editor.document.getText(selection).trim();
			if (!selectedText) {
				vscode.window.showInformationMessage('Select code to annotate.');
				return;
			}

			const groqInstance = await ensureGroq(context);
			if (!groqInstance) {
				vscode.window.showErrorMessage('Groq API key not configured. Please run the command again and enter your key.');
				return;
			}

			let commentResponse = '';
			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Annotate.ai: Generating...',
					},
					async () => {
						const completion = await groqInstance.chat.completions.create({
							model: 'llama-3.3-70b-versatile',
							messages: [
								{
									role: 'user',
									content: `Expert code reviewer: Provide a concise comment for this ${editor.document.languageId} snippet. Text only:\n\n${selectedText}`,
								},
							],
						});
						commentResponse = completion.choices?.[0]?.message?.content ?? '';
					}
				);
			} catch (err: any) {
				vscode.window.showErrorMessage(`LLM Error: ${err.message}`);
				return;
			}

			const commentText = formatAsComment(commentResponse, editor.document.languageId);
			await editor.edit((editBuilder) => {
				editBuilder.insert(selection.start, commentText);
			});

			const lineCount = commentText.split('\n').length - 1;
			const range = new vscode.Range(
				selection.start.line,
				0,
				selection.start.line + lineCount - 1,
				0
			);
			editor.setDecorations(addedLineDecoration, [range]);
			setTimeout(() => (isHighlighting = true), 100);
		}),

		// COMMAND 2: Annotate Entire File (Interactive + Denial logic)
		vscode.commands.registerCommand('annotate-ai.annotateFile', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;

			const groqInstance = await ensureGroq(context);
			if (!groqInstance) {
				vscode.window.showErrorMessage('Groq API key not configured. Please run the command again and enter your key.');
				return;
			}

			const document = editor.document;
			const originalText = document.getText();
			const previewUri = vscode.Uri.parse(`annotate-ai-preview:${document.uri.path}`);

			let updatedContent = '';
			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Annotating entire file...',
					},
					async () => {
						const completion = await groqInstance.chat.completions.create({
							model: 'llama-3.3-70b-versatile',
							messages: [
								{
									role: 'user',
									content: `You are an expert code reviewer. For the following ${document.languageId} source file, ensure every function and logical block has a brief comment describing intent. Add comments where missing, and update existing comments to be accurate. Do not change code behavior. Remove any leading/trailing quotes from comment text. Respond with the full updated file content only (no explanations).\n\n${originalText}`,
								},
							],
						});
						updatedContent = completion.choices?.[0]?.message?.content ?? '';
					}
				);
			} catch (err: any) {
				vscode.window.showErrorMessage(`Error: ${err.message}`);
				return;
			}

			let cleanedContent = updatedContent.trim();
			if (cleanedContent.startsWith('```')) {
				const lines = cleanedContent.split('\n');
				lines.shift();
				if (lines[lines.length - 1].trim() === '```') lines.pop();
				cleanedContent = lines.join('\n');
			}

			// Store original snapshot for potential Cancel revert
			provider.setSnapshot(previewUri, originalText);

			const diffParts = Diff.diffLines(originalText, cleanedContent);
			const reviewItems: Array<{
				newLineStart: number;
				newLineEnd: number;
				originalText: string;
				addedText: string;
				originalLineCount: number;
				addedLineCount: number;
			}> = [];

			let newLineIdx = 0;
			for (let i = 0; i < diffParts.length; i++) {
				const part = diffParts[i];
				if (part.removed) {
					const nextPart = diffParts[i + 1];
					if (nextPart && nextPart.added) {
						reviewItems.push({
							newLineStart: newLineIdx,
							newLineEnd: newLineIdx + nextPart.count!,
							originalText: part.value,
							addedText: nextPart.value,
							originalLineCount: part.count!,
							addedLineCount: nextPart.count!,
						});
						newLineIdx += nextPart.count!;
						i++;
					} else {
						reviewItems.push({
							newLineStart: newLineIdx,
							newLineEnd: newLineIdx,
							originalText: part.value,
							addedText: '',
							originalLineCount: part.count!,
							addedLineCount: 0,
						});
					}
				} else if (part.added) {
					reviewItems.push({
						newLineStart: newLineIdx,
						newLineEnd: newLineIdx + part.count!,
						originalText: '',
						addedText: part.value,
						originalLineCount: 0,
						addedLineCount: part.count!,
					});
					newLineIdx += part.count!;
				} else {
					newLineIdx += part.count!;
				}
			}

			// Apply all AI changes at once (Creates a single Undo entry)
			await editor.edit((editBuilder) => {
				const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
				editBuilder.replace(fullRange, cleanedContent);
			});

			let idx = 0;
			let lineDrift = 0;
			let userCancelledReview = true;

			while (idx < reviewItems.length) {
				const item = reviewItems[idx];
				const currentStart = Math.max(0, item.newLineStart + lineDrift);
				const currentEnd = Math.max(currentStart, item.newLineEnd + lineDrift);
				const range = new vscode.Range(
					Math.min(currentStart, document.lineCount - 1), 0,
					Math.min(currentEnd, document.lineCount), 0
				);

				if (item.addedText === '' && item.originalLineCount > 0) {
					editor.setDecorations(removedLineDecoration, [range]);
				} else {
					editor.setDecorations(addedLineDecoration, [range]);
				}

				editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

				const choice = await vscode.window.showQuickPick(
					[
						{ label: '$(check) Keep this change' },
						{ label: '$(close) Deny this change' },
						{ label: '$(check-all) Keep all remaining changes' },
						{ label: '$(clear-all) Deny all remaining changes' },
						{ label: 'Cancel' },
					],
					{ placeHolder: `Reviewing comment ${idx + 1} of ${reviewItems.length}`, ignoreFocusOut: true }
				);

				editor.setDecorations(addedLineDecoration, []);
				editor.setDecorations(removedLineDecoration, []);

				// Case 1: Escape key or explicit "Cancel"
				if (!choice || choice.label === 'Cancel') {
					break;
				}

				// Case 2: Keep current change
				if (choice.label.includes('Keep this change')) {
					idx++;
				}
				// Case 3: Deny current change
				else if (choice.label.includes('Deny this change')) {
					await editor.edit(eb => eb.replace(range, item.originalText), { undoStopBefore: false, undoStopAfter: false });
					lineDrift += (item.originalLineCount - item.addedLineCount);
					idx++;
				}
				// Case 4: Keep everything left
				else if (choice.label.includes('Keep all remaining')) {
					userCancelledReview = false;
					break;
				}
				// Case 5: Revert everything from here to the end
				else if (choice.label.includes('Deny all remaining')) {
					userCancelledReview = false; // We are intentionally finishing
					while (idx < reviewItems.length) {
						const remItem = reviewItems[idx];
						const rStart = remItem.newLineStart + lineDrift;
						const rEnd = remItem.newLineEnd + lineDrift;
						const rRange = new vscode.Range(Math.min(rStart, document.lineCount - 1), 0, Math.min(rEnd, document.lineCount), 0);

						await editor.edit(eb => eb.replace(rRange, remItem.originalText), { undoStopBefore: false, undoStopAfter: false });
						lineDrift += (remItem.originalLineCount - remItem.addedLineCount);
						idx++;
					}
					break;
				}

				if (idx === reviewItems.length) userCancelledReview = false;
			}

			// If the user hit Escape or "Cancel", revert the whole file to the snapshot
			if (userCancelledReview) {
				await editor.edit(eb => {
					eb.replace(new vscode.Range(0, 0, document.lineCount, 0), originalText);
				});
				vscode.window.showInformationMessage('Annotate.ai: File reverted to original state.');
			} else {
				vscode.window.showInformationMessage('Annotate.ai: Session complete.');
			}
		}),

		// COMMAND 3: Show Diff
		vscode.commands.registerCommand('annotate-ai.showDiff', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			const previewUri = vscode.Uri.parse(`annotate-ai-preview:${editor.document.uri.path}`);
			await vscode.commands.executeCommand(
				'vscode.diff',
				previewUri,
				editor.document.uri,
				'Annotate.ai: Changes'
			);
		}),

		// COMMAND 4: Generate README
		vscode.commands.registerCommand('annotate-ai.generateReadme', async () => {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {
				vscode.window.showErrorMessage('No workspace folder found.');
				return;
			}

			const groqInstance = await ensureGroq(context);
			if (!groqInstance) {
				vscode.window.showErrorMessage('Groq API key not configured. Please run the command again and enter your key.');
				return;
			}

			let readmeContent = '';
			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Annotate.ai: Analyzing project...',
					},
					async () => {
						// Get list of files in the workspace
						const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 100);

						// Prioritize key files
						const keyFiles = files.filter(file => {
							const fileName = file.fsPath.toLowerCase();
							return fileName.includes('package.json') ||
								fileName.includes('readme') ||
								fileName.includes('.md') ||
								fileName.endsWith('.ts') ||
								fileName.endsWith('.js') ||
								fileName.endsWith('.py') ||
								fileName.endsWith('.rs') ||
								fileName.endsWith('.go');
						}).slice(0, 10); // Limit to 10 key files

						let projectInfo = `# Project Analysis\n\n`;

						for (const file of keyFiles) {
							try {
								const document = await vscode.workspace.openTextDocument(file);
								const content = document.getText();
								if (content.length > 5000) continue; // Skip very large files

								projectInfo += `## ${file.fsPath.split('/').pop()}\n\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\`\n\n`;
							} catch (err) {
								// Skip files that can't be read
							}
						}

						const completion = await groqInstance.chat.completions.create({
							model: 'llama-3.3-70b-versatile',
							messages: [
								{
									role: 'user',
									content: `You are an expert technical writer. Based on the following project files, create a comprehensive README.md file. Include:

1. Project title and description
2. Features/functionality overview
3. Installation/setup instructions
4. Usage examples
5. API documentation if applicable
6. Dependencies
7. Contributing guidelines
8. License information

Be thorough but concise. Format properly with Markdown.

Project files:
${projectInfo}`,
								},
							],
						});
						readmeContent = completion.choices?.[0]?.message?.content ?? '';
					}
				);
			} catch (err: any) {
				vscode.window.showErrorMessage(`Error generating README: ${err.message}`);
				return;
			}

			// Check if README.md already exists
			const readmeUri = vscode.Uri.joinPath(workspaceFolder.uri, 'README.md');
			let existingContent = '';
			let readmeExists = false;

			try {
				const existingDocument = await vscode.workspace.openTextDocument(readmeUri);
				existingContent = existingDocument.getText();
				readmeExists = true;
			} catch (err) {
				// README doesn't exist, which is fine
			}

			if (readmeExists && existingContent.trim()) {
				// Show diff and ask for approval
				const previewUri = vscode.Uri.parse(`annotate-ai-preview:README-new.md`);
				provider.setSnapshot(previewUri, readmeContent);

				// Show the diff: existing README (left) vs new README (right)
				await vscode.commands.executeCommand(
					'vscode.diff',
					readmeUri,
					previewUri,
					'Annotate.ai: README Changes'
				);

				// Ask user to approve or deny
				const choice = await vscode.window.showQuickPick(
					[
						{ label: '$(check) Accept new README' },
						{ label: '$(close) Keep existing README' },
					],
					{ placeHolder: 'Review the generated README changes', ignoreFocusOut: true }
				);

				if (!choice) {
					// User dismissed the menu, keep existing
					await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
					vscode.window.showInformationMessage('Existing README.md kept unchanged.');
					return;
				}

				if (choice.label.includes('Accept new README')) {
					// Write the new content
					await vscode.workspace.fs.writeFile(readmeUri, Buffer.from(readmeContent, 'utf8'));
					vscode.window.showInformationMessage('README.md updated successfully!');
				} else {
					// Keep existing, just close the diff
					await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
					vscode.window.showInformationMessage('Existing README.md kept unchanged.');
				}
			} else {
				// Create new README
				await vscode.workspace.fs.writeFile(readmeUri, Buffer.from(readmeContent, 'utf8'));
				vscode.window.showInformationMessage('README.md generated successfully!');

				// Open the generated README
				const document = await vscode.workspace.openTextDocument(readmeUri);
				await vscode.window.showTextDocument(document);
			}
		})
	);
}

export function deactivate() { }