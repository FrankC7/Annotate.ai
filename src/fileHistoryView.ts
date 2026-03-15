import * as vscode from 'vscode';
import * as cp from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const exec = promisify(cp.exec);

export class FileHistoryViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'annotate-ai.fileHistoryView';

	private _view?: vscode.WebviewView;
	private _currentFilePath?: string;

	constructor(
		private readonly _extensionUri: vscode.Uri,
	) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this._extensionUri
			]
		};

		webviewView.webview.onDidReceiveMessage(data => {
			if (data.type === 'showCommit' && this._currentFilePath) {
				vscode.commands.executeCommand('annotate-ai.showFileAtCommit', data.hash, this._currentFilePath);
			}
		});

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		this.update();
	}

	public async update() {
		if (!this._view) {
			return;
		}

		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			this._view.webview.postMessage({ type: 'noFile' });
			return;
		}

		const document = editor.document;
		if (document.isUntitled || document.uri.scheme !== 'file') {
			this._view.webview.postMessage({ type: 'noFile' });
			return;
		}

		try {
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
			if (!workspaceFolder) {
				this._view.webview.postMessage({ type: 'noGit' });
				return;
			}

			const cwd = workspaceFolder.uri.fsPath;
			const filePath = document.uri.fsPath;
			this._currentFilePath = filePath;

			// Check if git is available
			try {
				await exec('git --version', { cwd });
			} catch (e) {
				this._view.webview.postMessage({ type: 'noGit' });
				return;
			}

			// Get history
			this._view.webview.postMessage({ type: 'loading' });
			const { stdout } = await exec(`git log --follow --pretty=format:"%H|%h|%s|%an|%aI" -- "${filePath}"`, { cwd });

			if (!stdout.trim()) {
				this._view.webview.postMessage({ type: 'noHistory' });
				return;
			}

			const commits = stdout.trim().split('\n').map(line => {
				const [hash, shortHash, message, author, date] = line.split('|');
				return { hash, shortHash, message, author, date };
			});

			this._view.webview.postMessage({ type: 'history', commits });
		} catch (error) {
			console.error(error);
			this._view.webview.postMessage({ type: 'error', message: String(error) });
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>File History</title>
	<style>
		body {
			padding: 10px;
			color: var(--vscode-editor-foreground);
			font-family: var(--vscode-font-family);
			background-color: var(--vscode-editor-background);
		}
		
		.message-container {
			display: flex;
			justify-content: center;
			align-items: center;
			height: 100vh;
			text-align: center;
			color: var(--vscode-descriptionForeground);
		}

		.timeline {
			position: relative;
			padding-left: 20px;
		}

		.timeline::before {
			content: '';
			position: absolute;
			top: 0;
			bottom: 0;
			left: 6px;
			width: 2px;
			background-color: var(--vscode-textLink-foreground);
			opacity: 0.3;
		}

		.commit {
			position: relative;
			margin-bottom: 20px;
			cursor: pointer;
			padding: 8px;
			border-radius: 4px;
			transition: background-color 0.2s;
		}

		.commit:hover {
			background-color: var(--vscode-list-hoverBackground);
		}

		.commit::before {
			content: '';
			position: absolute;
			width: 10px;
			height: 10px;
			border-radius: 50%;
			background-color: var(--vscode-textLink-foreground);
			left: -18px;
			top: 5px;
			border: 2px solid var(--vscode-editor-background);
		}

		.commit-header {
			display: flex;
			align-items: baseline;
			justify-content: space-between;
			margin-bottom: 4px;
		}

		.commit-message {
			font-weight: bold;
			margin-bottom: 4px;
			word-break: break-word;
		}

		.commit-meta {
			font-size: 0.85em;
			color: var(--vscode-descriptionForeground);
		}

		.commit-hash {
			font-family: var(--vscode-editor-font-family);
			color: var(--vscode-textLink-foreground);
			cursor: pointer;
		}

		.commit-hash:hover {
			text-decoration: underline;
		}
	</style>
</head>
<body>
	<div id="content">
		<div class="message-container">Select a file to view its history</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		const contentDiv = document.getElementById('content');

		function formatDate(isoString) {
			const date = new Date(isoString);
			return date.toLocaleDateString(undefined, {
				month: 'short',
				day: 'numeric',
				year: 'numeric'
			}) + ' ' + date.toLocaleTimeString(undefined, {
				hour: '2-digit',
				minute: '2-digit'
			});
		}

		window.addEventListener('message', event => {
			const message = event.data;

			switch (message.type) {
				case 'noFile':
					contentDiv.innerHTML = '<div class="message-container">Select a file to view its history.</div>';
					break;
				case 'noGit':
					contentDiv.innerHTML = '<div class="message-container">Git is not available in this workspace.</div>';
					break;
				case 'noHistory':
					contentDiv.innerHTML = '<div class="message-container">No git history found for this file.</div>';
					break;
				case 'loading':
					contentDiv.innerHTML = '<div class="message-container">Loading history...</div>';
					break;
				case 'error':
					contentDiv.innerHTML = \`<div class="message-container">Error: \${message.message}</div>\`;
					break;
				case 'history':
					if (!message.commits || message.commits.length === 0) {
						contentDiv.innerHTML = '<div class="message-container">No git history found.</div>';
						return;
					}

					let html = '<div class="timeline">';
					message.commits.forEach(commit => {
						html += \`
							<div class="commit" onclick="showCommit('\${commit.hash}')">
								<div class="commit-header">
									<span class="commit-hash" title="Copy Commit Hash" onclick="copyHash(event, '\${commit.hash}')">\${commit.shortHash}</span>
									<span class="commit-meta">\${formatDate(commit.date)}</span>
								</div>
								<div class="commit-message">\${escapeHtml(commit.message)}</div>
								<div class="commit-meta">\${escapeHtml(commit.author)}</div>
							</div>
						\`;
					});
					html += '</div>';
					contentDiv.innerHTML = html;
					break;
			}
		});

		function copyHash(event, hash) {
			event.stopPropagation();
			navigator.clipboard.writeText(hash).then(() => {
				// We don't have direct access to show information message here
				// Could post a message back to extension to show it
			});
		}

		function showCommit(hash) {
			vscode.postMessage({ type: 'showCommit', hash });
		}

		function escapeHtml(unsafe) {
			return (unsafe || '').toString()
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;")
				.replace(/'/g, "&#039;");
		}
	</script>
</body>
</html>`;
	}
}
