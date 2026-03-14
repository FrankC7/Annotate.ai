import * as vscode from 'vscode';
import Groq from 'groq-sdk';
import * as Diff from 'diff';

// --- HELPER CLASS ---
export class PreviewProvider implements vscode.TextDocumentContentProvider {
	private _content = new Map<string, string>();

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this._content.get(uri.path) || '';
	}

	setSnapshot(uri: vscode.Uri, text: string) {
		this._content.set(uri.path, text);
	}
}

// --- GLOBALS & CONFIG ---

const addedLineDecoration = vscode.window.createTextEditorDecorationType({
	backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
	isWholeLine: true,
});

const removedLineDecoration = vscode.window.createTextEditorDecorationType({
	backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
	isWholeLine: true,
});

let isHighlighting = false;

let groq: Groq | undefined;

async function ensureGroq(context: vscode.ExtensionContext): Promise<Groq | undefined> {
	if (groq) return groq;

	let apiKey = await context.secrets.get('groqApiKey');
	if (!apiKey) {
		const input = await vscode.window.showInputBox({
			prompt: 'Enter your Groq API Key',
			password: true,
			placeHolder: 'gsk_...'
		});
		if (input) {
			await context.secrets.store('groqApiKey', input);
			apiKey = input;
		}
	}
	if (apiKey) {
		groq = new Groq({ apiKey });
	}
	return groq;
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

// --- ACTIVATION ---
export function activate(context: vscode.ExtensionContext) {
	const provider = new PreviewProvider();
	const scheme = 'annotate-ai-preview';

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(scheme, provider)
	);

	vscode.workspace.onDidChangeTextDocument((event) => {
		const editor = vscode.window.activeTextEditor;
		if (editor && isHighlighting) {
			editor.setDecorations(addedLineDecoration, []);
			editor.setDecorations(removedLineDecoration, []);
			isHighlighting = false;
		}
	});

	// COMMAND 1: Annotate Selection
	let annotateCommand = vscode.commands.registerCommand(
		'annotate-ai.annotateSelection',
		async () => {
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
		}
	);

	// COMMAND 2: Annotate Entire File (Interactive + Denial logic)
	let annotateFileCommand = vscode.commands.registerCommand(
		'annotate-ai.annotateFile',
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;

			const groqInstance = await ensureGroq(context);
			if (!groqInstance) {
				vscode.window.showErrorMessage('Groq API key not configured. Please run the command again and enter your key.');
				return;
			}

			const document = editor.document;
			const originalText = document.getText();
			const previewUri = vscode.Uri.parse(`${scheme}:${document.uri.path}`);

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
		}
	);

	// COMMAND 3: Show Diff
	let diffCommand = vscode.commands.registerCommand('annotate-ai.showDiff', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;
		const previewUri = vscode.Uri.parse(`${scheme}:${editor.document.uri.path}`);
		await vscode.commands.executeCommand(
			'vscode.diff',
			previewUri,
			editor.document.uri,
			'Annotate.ai: Changes'
		);
	});

	// COMMAND 4: Generate README
	let generateReadmeCommand = vscode.commands.registerCommand('annotate-ai.generateReadme', async () => {
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
			const previewUri = vscode.Uri.parse(`${scheme}:README-new.md`);
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
	});

	context.subscriptions.push(annotateCommand, annotateFileCommand, diffCommand, generateReadmeCommand);
}

export function deactivate() { }