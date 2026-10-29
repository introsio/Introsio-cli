import claude from './claude.mjs';
import codex from './codex.mjs';
import gemini from './gemini.mjs';
import cursor from './cursor.mjs';
import opencode from './opencode.mjs';
import vscode from './vscode.mjs';
import windsurf from './windsurf.mjs';

export const AGENTS = [claude, codex, gemini, cursor, opencode, vscode, windsurf];
export const agentById = (id) => AGENTS.find((agent) => agent.id === id);
