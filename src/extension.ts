import * as vscode from 'vscode';
import Groq from 'groq-sdk';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
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
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '..', '.env');
dotenv.config({ path: envPath });

const addedLineDecoration = vscode.window.createTextEditorDecorationType({
	backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
	isWholeLine: true,
});

let isHighlighting = false;

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

	const groqApiKey = process.env.GROQ_API_KEY;
	const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : undefined;

	vscode.workspace.onDidChangeTextDocument((event) => {
		const editor = vscode.window.activeTextEditor;
		if (editor && isHighlighting) {
			editor.setDecorations(addedLineDecoration, []);
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

			const originalText = editor.document.getText();
			const previewUri = vscode.Uri.parse(`${scheme}:${editor.document.uri.path}`);
			provider.setSnapshot(previewUri, originalText);

			if (!groqApiKey || !groq) {
				vscode.window.showErrorMessage('GROQ_API_KEY not found.');
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
						const completion = await groq.chat.completions.create({
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

	// COMMAND 2: Annotate Entire File (The interactive solution)
	let annotateFileCommand = vscode.commands.registerCommand(
		'annotate-ai.annotateFile',
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !groq) return;

			const document = editor.document;
			const currentText = document.getText();
			const previewUri = vscode.Uri.parse(`${scheme}:${document.uri.path}`);
			const updatedPreviewUri = vscode.Uri.parse(
				`${scheme}:${document.uri.path}-updated`
			);

			let updatedContent = '';
			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Annotating entire file...',
					},
					async () => {
						const completion = await groq.chat.completions.create({
							model: 'llama-3.3-70b-versatile',
							messages: [
								{
									role: 'user',
									content: `Add/update comments in this ${document.languageId} file. Do not change code logic. Return full updated file content only:\n\n${currentText}`,
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

			// Strip markdown fences if LLM included them
			let cleanedContent = updatedContent.trim();
			if (cleanedContent.startsWith('```')) {
				const lines = cleanedContent.split('\n');
				lines.shift();
				if (lines[lines.length - 1].trim() === '```') lines.pop();
				cleanedContent = lines.join('\n');
			}

			provider.setSnapshot(previewUri, currentText);
			provider.setSnapshot(updatedPreviewUri, cleanedContent);

			const diffParts = Diff.diffLines(currentText, cleanedContent);
			const hunks: Array<{
				startLine: number;
				endLine: number;
				newText: string;
			}> = [];
			let currentLine = 0;

			for (let i = 0; i < diffParts.length; i++) {
				const part = diffParts[i];
				if (part.removed) {
					const nextPart = diffParts[i + 1];
					if (nextPart && nextPart.added) {
						hunks.push({
							startLine: currentLine,
							endLine: currentLine + part.count!,
							newText: nextPart.value,
						});
						currentLine += part.count!;
						i++;
					} else {
						hunks.push({
							startLine: currentLine,
							endLine: currentLine + part.count!,
							newText: '',
						});
						currentLine += part.count!;
					}
				} else if (part.added) {
					hunks.push({
						startLine: currentLine,
						endLine: currentLine,
						newText: part.value,
					});
				} else {
					currentLine += part.count!;
				}
			}

			if (hunks.length === 0) {
				vscode.window.showInformationMessage('No changes detected.');
				return;
			}

			const acceptedHunks: typeof hunks = [];
			let idx = 0;

			while (idx < hunks.length) {
				const hunk = hunks[idx];
				const highlightStart = Math.min(hunk.startLine, document.lineCount - 1);
				const highlightEnd = Math.max(
					highlightStart,
					Math.min(hunk.endLine - 1, document.lineCount - 1)
				);
				const range = new vscode.Range(highlightStart, 0, highlightEnd, 0);

				editor.setDecorations(addedLineDecoration, [range]);
				editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

				const choice = await vscode.window.showQuickPick(
					[
						{ label: '$(check) Keep this change', detail: hunk.newText.trim() },
						{ label: '$(close) Deny this change' },
						{ label: '$(check-all) Keep all remaining' },
						{ label: '$(clear-all) Deny all remaining' },
						{
							label: '$(diff-multiple) Open side-by-side diff',
							detail: 'Review all changes at once',
						},
						{ label: 'Cancel' },
					],
					{ placeHolder: `Change ${idx + 1} of ${hunks.length}`, ignoreFocusOut: true }
				);

				editor.setDecorations(addedLineDecoration, []);

				if (!choice || choice.label === 'Cancel') return;
				if (choice.label.includes('Open side-by-side diff')) {
					await vscode.commands.executeCommand(
						'vscode.diff',
						previewUri,
						updatedPreviewUri,
						'Annotate: Preview All'
					);
					continue;
				}

				if (choice.label.includes('Keep this change')) {
					acceptedHunks.push(hunk);
					idx++;
				} else if (choice.label.includes('Deny this change')) {
					idx++;
				} else if (choice.label.includes('Keep all remaining')) {
					acceptedHunks.push(...hunks.slice(idx));
					break;
				} else if (choice.label.includes('Deny all remaining')) {
					break;
				}
			}

			if (acceptedHunks.length > 0) {
				const edit = new vscode.WorkspaceEdit();
				for (const h of acceptedHunks) {
					const r = new vscode.Range(h.startLine, 0, h.endLine, 0);
					edit.replace(document.uri, r, h.newText);
				}
				await vscode.workspace.applyEdit(edit);
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

	context.subscriptions.push(annotateCommand, annotateFileCommand, diffCommand);
}

export function deactivate() {}