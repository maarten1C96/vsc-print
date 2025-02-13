import { PrintPreview } from './print-preview';
import { logger } from './logger';
import { HtmlDocumentBuilder } from './html-document-builder';
import * as vscode from 'vscode';
import * as http from "http";
import * as path from "path";
import * as child_process from "child_process";
import { localise } from './imports';
import * as nodeCrypto from "crypto";
import { filenameByCaption } from "./imports";
import { DocumentRenderer } from './document-renderer';

let settingsCss: string = require("./css/settings.css").default.toString();

export class PrintSession {
	static port: number;
	private created = new Date().valueOf();
	public completed = false;
	public age(): number {
		return new Date().valueOf() - this.created;
	}
	pageBuilder: HtmlDocumentBuilder | undefined;
	public ready: Promise<void>;
	public sessionId = nodeCrypto.randomUUID();
	public source: any;
	constructor(source: any, preview: boolean = true) {
		logger.debug(`Creating a print session object for ${source}`);
		const printConfig = vscode.workspace.getConfiguration("print");
		const editorConfig = vscode.workspace.getConfiguration("editor");
		this.ready = new Promise(async (resolve, reject) => {
			try {
				const baseUrl = `http://localhost:${PrintSession.port}/${this.sessionId}/`;
				const editor = vscode.window.activeTextEditor;
				let document = editor?.document;
				let printLineNumbers = printConfig.lineNumbers === "on" || (printConfig.lineNumbers === "inherit" && editorConfig.lineNumbers === "on");
				const rootDocumentContentSource = await this.rootDocumentContentSource(source!);
				switch (rootDocumentContentSource) {
					case "editor": {
						logger.debug("Using the buffer of the active editor");
						logger.debug(`Source code line numbers will ${printLineNumbers ? "" : "NOT "}be printed`);
						logger.debug(`Source code colour scheme is "${printConfig.colourScheme}"`);
						if (!document) throw "This can't happen";
						this.source = document.uri;
						this.pageBuilder = new HtmlDocumentBuilder(
							baseUrl,
							document.uri,
							document.getText(),
							document.languageId,
							printLineNumbers
						);
					}
						break;
					case "selection": {
						logger.debug("Printing the selection in the active editor");
						logger.debug(`Source code line numbers will ${printLineNumbers ? "" : "NOT "}be printed`);
						logger.debug(`Source code colour scheme is "${printConfig.colourScheme}"`);
						if (!document) throw "This can't happen";
						const selection = editor?.selection;
						if (!selection) throw "This can't happen";
						this.source = document.uri;
						if (selection.isEmpty) { // use entire doc
							const selectedText = document!.getText().replace(/\s*$/, "");
							const langId = document!.languageId;
							const startLine = selection.start.line + 1; // zero based to one based
							this.pageBuilder = new HtmlDocumentBuilder(
								baseUrl,
								document.uri,
								selectedText,
								langId,
								printLineNumbers,
								startLine
							);
						} else {
							const selectedText = document!.getText(new vscode.Range(selection.start, selection.end)).replace(/\s*$/, "");
							const langId = document!.languageId;
							const startLine = selection.start.line + 1; // zero based to one based
							this.pageBuilder = new HtmlDocumentBuilder(
								baseUrl,
								document.uri,
								selectedText,
								langId,
								printLineNumbers,
								startLine
							);
						}
					}
						break;
					case "file":
						document = await vscode.workspace.openTextDocument(source!);
						logger.debug(`Printing the file ${document.uri.fsPath}`);
						this.source = document.uri;
						logger.debug(`Source code line numbers will ${printLineNumbers ? "" : "NOT "}be printed`);
						logger.debug(`Source code colour scheme is "${printConfig.colourScheme}"`);
						this.pageBuilder = new HtmlDocumentBuilder(
							baseUrl,
							document.uri,
							document.getText(),
							document.languageId,
							printLineNumbers
						);
						break;
					case "folder":
						logger.debug(`Printing the folder ${source!.fsPath}`);
						this.pageBuilder = new HtmlDocumentBuilder(baseUrl, source, "", "folder", printLineNumbers);
						break;
					case "multiselection":
						logger.debug(`Printing multiselection`);
						const multiselectionPath = vscode.workspace.getWorkspaceFolder(source[0])!.uri;
						this.pageBuilder = new HtmlDocumentBuilder(baseUrl, multiselectionPath, "", "multiselection", printLineNumbers, 1, source);
						break;
					default:
						logger.error(rootDocumentContentSource);
						vscode.window.showErrorMessage(rootDocumentContentSource);
						break;
				}
				if (preview) {
					const renderer = this.pageBuilder;
					const html = await renderer!.build();
					PrintPreview.show(html)
				} else {
					if (printConfig.alternateBrowser) {
						launchAlternateBrowser(this.getUrl())
					} else {
						vscode.env.openExternal(vscode.Uri.parse(this.getUrl()));
					}
				}
				resolve();
			} catch (err) {
				reject(err);
			}
		});
	}

	public async respond(urlParts: string[], response: http.ServerResponse) {
		await this.ready;

		if (urlParts.length === 3 && urlParts[2] === "") {
			logger.debug(`Responding to base document request for session ${urlParts[1]}`)
			const renderer = this.pageBuilder;
			const html = await renderer!.build();
			response.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Length": Buffer.byteLength(html, 'utf-8')
			});
			response.end(html);
		} else if (urlParts.length === 3 && urlParts[2] === "completed") {
			logger.debug(`Responding to "completed" request for session ${urlParts[1]}`)
			this.completed = true;
			response.writeHead(200, {
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Length": 2
			});
			response.end("OK");
		} else if (urlParts.length === 4 && urlParts[2] === "workspace.resource") {
			logger.debug(`Responding to workspace.resource request for session ${urlParts[1]}`);
			const basePath = vscode.workspace.getWorkspaceFolder(this.source!)?.uri.fsPath!;
			const resourcePath = path.join(basePath, ...urlParts.slice(3));
			await relativeResource(resourcePath);
		} else if (urlParts.length === 4 && urlParts[2] === "bundled") {
			logger.debug(`Responding to bundled request for ${urlParts[3]} in session ${urlParts[1]}`);
			switch (urlParts[3]) {
				case "colour-scheme.css":
					let colourScheme = vscode.workspace.getConfiguration("print").colourScheme;
					let colourSchemeName: string = filenameByCaption[colourScheme];
					logger.debug(`Loading colour scheme from ${colourSchemeName}`);
					let colourSchemeCss: string = require(`highlight.js/styles/${colourSchemeName}.css`).default.toString();
					response.writeHead(200, {
						"Content-Type": "text/css; charset=utf-8",
						"Content-Length": colourSchemeCss.length,
						'Cache-Control': 'no-cache'
					});
					response.end(colourSchemeCss);
					break;
				case "settings.css":
					const printConfig = vscode.workspace.getConfiguration("print");
					const editorConfig = vscode.workspace.getConfiguration("editor");
					const css = settingsCss
						.replace("FONT_FAMILY", editorConfig.fontFamily)
						.replace("FONT_SIZE", printConfig.fontSize)
						.replace("LINE_SPACING", printConfig.lineSpacing)
						.replace("TAB_SIZE", editorConfig.tabSize)
					response.writeHead(200, {
						"Content-Type": "text/css; charset=utf-8",
						"Content-Length": Buffer.byteLength(css, "utf-8")
					});
					response.end(css);
					break;
				default:
					try {
						const rootDocumentRenderer = DocumentRenderer.get(this.pageBuilder!.language);
						const resourceDescriptor = rootDocumentRenderer.getResource(urlParts[3], this.source);
						let contentLength: number;
						if (typeof resourceDescriptor.content === "string") {
							contentLength = Buffer.byteLength(resourceDescriptor.content, "utf-8")
						} else {
							contentLength = resourceDescriptor.content.byteLength;
						}
						response.writeHead(200, {
							"Content-Type": resourceDescriptor.mimeType,
							"Content-Length": contentLength
						});
						response.end(resourceDescriptor.content);
					} catch {
						logger.debug(`bundled/${urlParts[3]} not found`);
						response.writeHead(404, {
							"Content-Type": "text/plain; charset=utf-8",
							"Content-Length": 9
						});
						response.end("Not found");
					}
					break;
			}
		} else {
			const basePath = path.dirname(this.source!.fsPath);
			const resourcePath = path.join(basePath, ...urlParts.slice(2));
			await relativeResource(resourcePath);
		}

		async function relativeResource(resourcePath: string) {
			const fileUri: vscode.Uri = vscode.Uri.file(resourcePath);
			const fileExt = path.extname(resourcePath);
			switch (fileExt.toLowerCase()) {
				case ".jpg":
				case ".gif":
				case ".png":
				case ".webp":
					response.writeHead(200, {
						"Content-Type": `image/${fileExt.substring(1).toLowerCase()}`,
						"Content-Length": (await vscode.workspace.fs.stat(fileUri)).size
					});
					response.end(await vscode.workspace.fs.readFile(fileUri));
					break;
				case ".svg":
					response.writeHead(200, {
						"Content-Type": `image/svg+xml`,
						"Content-Length": (await vscode.workspace.fs.stat(fileUri)).size
					});
					response.end(await vscode.workspace.fs.readFile(fileUri));
					break;
				case ".css":
					response.writeHead(200, {
						"Content-Type": "text/css",
						"Content-Length": (await vscode.workspace.fs.stat(fileUri)).size
					});
					response.end(await vscode.workspace.fs.readFile(fileUri));
					break;
				default:
					response.writeHead(403, {
						"Content-Type": "text/plain",
						"Content-Length": 9
					});
					response.end("Forbidden");
					break;
			}
		}
	}

	public getUrl(): string { return `http://localhost:${PrintSession.port}/${this.sessionId}/`; }

	async rootDocumentContentSource(source: vscode.Uri | Array<vscode.Uri>): Promise<string> {
		if (Array.isArray(source))
			return "multiselection";
		else {
			try {
				await vscode.workspace.fs.stat(source); // barfs when file does not exist (unsaved)
				const uristat = await vscode.workspace.fs.stat(source);
				if (uristat.type === vscode.FileType.Directory) return "folder";
				const editor = vscode.window.activeTextEditor;
				if (editor && source.toString() === editor.document.uri.toString()) {
					return !editor.selection || editor.selection.isEmpty || editor.selection.isSingleLine ? "editor" : "selection";
				} else {
					return "file";
				}
			} catch (ex) {
				if (vscode.window.activeTextEditor) {
					return "editor";
				} else {
					return `Content source could not be determined. "${source}" does not resolve to a file and there is no active editor.`;
				}
			}
		}
	}
}

async function launchAlternateBrowser(url: string) {
	logger.debug("Alternate browser is selected");
	const printConfig = vscode.workspace.getConfiguration("print");
	const isRemoteWorkspace = !!vscode.env.remoteName;
	logger.debug(`Workspace is ${isRemoteWorkspace ? "remote" : "local"}`);
	const isBrowserPathDefined = !!printConfig.browserPath;
	logger.debug(`Browser path ${isBrowserPathDefined ? "IS" : "is NOT"} defined`);

	if (!isBrowserPathDefined) {
		const msg = "Alternate browser path not set. Default browser will be used.";
		logger.warn(msg);
		vscode.window.showWarningMessage(msg);
	}
	const forceUseAgent = false;
	if (forceUseAgent || isRemoteWorkspace) {
		logger.debug(`forceUseAgent=${forceUseAgent}, isRemoteWorkspace=${isRemoteWorkspace}`)
		try {
			const cmds = await vscode.commands.getCommands(true);
			if (!cmds.includes("print.launchBrowser")) {
				throw new Error("The remote printing agent is not accessible");
			}
			if (isBrowserPathDefined) {
				vscode.commands.executeCommand("print.launchBrowser", url);
			} else {
				vscode.env.openExternal(vscode.Uri.parse(url));
			}
		} catch {
			const msg = "The remote printing agent is not answering. As a result the default browser has been used."
			logger.warn(msg);
			vscode.window.showWarningMessage(msg);
			vscode.env.openExternal(vscode.Uri.parse(url));
		}
	} else {
		if (isBrowserPathDefined) {
			const cmd = escapePath(printConfig.browserPath);
			child_process.exec(`${cmd} ${url}`, (error: child_process.ExecException | null, stdout: string, stderr: string) => {
				if (error || stderr) {
					vscode.window.showErrorMessage(error ? error.message : stderr);
				}
			});
		} else {
			vscode.env.openExternal(vscode.Uri.parse(url));
		}
	}
}

function escapePath(path: string) {
	switch (process.platform) {
		case "win32":
			return path.includes('"') || !path.includes(" ") ? path : `"${path}"`;
		default:
			return path.replace(/ /g, "\\ ");
	}
}
