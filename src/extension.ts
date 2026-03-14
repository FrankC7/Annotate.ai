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

const removedLineDecoration = vscode.window.createTextEditorDecorationType({
	backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
	isWholeLine: true,
});

let isHighlighting = false;

let currentHunks: Array<{
	startLine: number;
	endLine: number;
	newText: string;
}> | undefined;
let accepted: boolean[] | undefined;

const codeLensProvider = new class implements vscode.CodeLensProvider {
	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		if (!currentHunks || !accepted) return [];
		const lenses: vscode.CodeLens[] = currentHunks.map((hunk, idx) => {
			const line = Math.min(hunk.startLine, document.lineCount - 1);
			const range = new vscode.Range(line, 0, line, 0);
			const status = accepted![idx] ? 'Accepted' : 'Proposed';
			const preview = hunk.newText.trim() || 'Deletion';
			const lens = new vscode.CodeLens(range);
			lens.command = {
				title: `${status}: ${preview}`,
				command: 'annotate-ai.toggleHunk',
				arguments: [idx]
			};
			return lens;
		});
		// Add apply lens at top
		if (lenses.length > 0) {
			const applyLens = new vscode.CodeLens(new vscode.Range(0, 0, 0, 0));
			applyLens.command = {
				title: 'Apply accepted changes',
				command: 'annotate-ai.applyChanges'
			};
			lenses.push(applyLens);
		}
		return lenses;
	}
};

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
export function activate(ctx: vscode.ExtensionContext) {
	const provider = new PreviewProvider();
	const scheme = 'annotate-ai-preview';

	ctx.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(scheme, provider)
	);

	ctx.subscriptions.push(
		vscode.languages.registerCodeLensProvider('*', codeLensProvider)
	);

	const groqApiKey = process.env.GROQ_API_KEY;
	const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : undefined;

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
									content: `Add comprehensive and detailed comments to this ${document.languageId} file. Comment every function, class, method, variable declaration, loops, and any complex logic. Explain what each part does in clear, concise comments. Do not change the code logic. Return the full updated file content only, ensuring the entire file is included without any truncation:\n\n${currentText}`,
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

			currentHunks = hunks;
			accepted = new Array(hunks.length).fill(false);
			vscode.commands.executeCommand('vscode.executeCodeLensProviderRefresh');
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

	// COMMAND 4: Toggle Hunk
	let toggleCommand = vscode.commands.registerCommand('annotate-ai.toggleHunk', (idx: number) => {
		if (!accepted) return;
		accepted![idx] = !accepted![idx];
		vscode.commands.executeCommand('vscode.executeCodeLensProviderRefresh');
	});

	// COMMAND 5: Apply Changes
	let applyCommand = vscode.commands.registerCommand('annotate-ai.applyChanges', async () => {
		if (!currentHunks || !accepted) return;
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;
		const acceptedHunks = currentHunks.filter((_, idx) => accepted![idx]);
		if (acceptedHunks.length > 0) {
			const edit = new vscode.WorkspaceEdit();
			for (const h of acceptedHunks) {
				const r = new vscode.Range(h.startLine, 0, h.endLine, 0);
				edit.replace(editor.document.uri, r, h.newText);
			}
			await vscode.workspace.applyEdit(edit);
		}
		currentHunks = undefined;
		accepted = undefined;
		vscode.commands.executeCommand('vscode.executeCodeLensProviderRefresh');
	});

	ctx.subscriptions.push(annotateCommand, annotateFileCommand, diffCommand, toggleCommand, applyCommand);
}

export function deactivate() { }