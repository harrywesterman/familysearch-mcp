import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { loadConfig, saveConfig, type FamilySearchConfig } from './config.js';
import {
  FamilySearchSessionClient,
  FamilySearchSessionError,
  formatCardBirthDeath,
  formatPersonSummary,
} from './session-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loginScriptPath = join(__dirname, '..', 'scripts', 'browser-login.mjs');

let config: FamilySearchConfig = loadConfig();
const sessionClient = new FamilySearchSessionClient({
  sessionId: config.sessionId,
  fsAnid: config.fsAnid,
  cookies: config.cookies,
});

const persistConfig = () => saveConfig(config);

const server = new McpServer({
  name: 'familysearch',
  version: '2.0.0',
});

function isAuthenticated(): boolean {
  return sessionClient.isAuthenticated();
}

function authRequiredText(): string {
  return 'Not authenticated. Run login-with-browser or set-session-cookie first.';
}

function formatError(error: unknown): string {
  if (error instanceof FamilySearchSessionError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return JSON.stringify(error);
}

function formatNote(note: unknown): string | null {
  if (typeof note === 'string') return note;
  if (note && typeof note === 'object') {
    const record = note as Record<string, unknown>;
    const text = record.text ?? record.content ?? record.value;
    if (typeof text === 'string') return text;
  }
  return null;
}

function extractCookieValue(cookieHeader: string, name: string): string {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] || '';
}

function applySessionCookies(cookies: string, sessionId?: string, fsAnid?: string): void {
  config.cookies = cookies.trim();
  config.sessionId = sessionId?.trim() || extractCookieValue(config.cookies, 'fssessionid');
  config.fsAnid = fsAnid?.trim() || extractCookieValue(config.cookies, 'fs_anid');
  sessionClient.setSession(config.sessionId, config.fsAnid, config.cookies);
}

server.tool(
  'set-session-cookie',
  'Authenticate using browser cookies copied from familysearch.org (DevTools console: copy(document.cookie))',
  {
    cookies: z
      .string()
      .optional()
      .describe('Full cookie string from document.cookie (recommended)'),
    sessionId: z
      .string()
      .optional()
      .describe('The fssessionid cookie alone (may be blocked without bot-protection cookies)'),
    fsAnid: z.string().optional().describe('Optional fs_anid cookie value'),
  },
  async ({ cookies, sessionId, fsAnid }: { cookies?: string; sessionId?: string; fsAnid?: string }) => {
    if (!cookies && !sessionId) {
      return {
        content: [{ type: 'text', text: 'Provide either cookies (full string, recommended) or sessionId.' }],
      };
    }

    applySessionCookies(cookies || '', sessionId, fsAnid);

    try {
      const user = await sessionClient.validateSession({
        displayName: config.userDisplayName,
        personId: config.userPersonId,
      });
      config.userDisplayName = user.displayName;
      config.userPersonId = user.personId;
      persistConfig();

      return {
        content: [
          {
            type: 'text',
            text: `Browser session saved. Authenticated as ${user.displayName}${user.personId ? ` (${user.personId})` : ''}.`,
          },
        ],
      };
    } catch (error) {
      config.cookies = '';
      config.sessionId = '';
      config.fsAnid = '';
      sessionClient.setSession('', '', '');
      persistConfig();
      return {
        content: [{ type: 'text', text: `Session validation failed: ${formatError(error)}` }],
      };
    }
  },
);

server.tool(
  'login-with-browser',
  'Open a browser window to log in to FamilySearch and save the session cookie locally',
  {},
  async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [loginScriptPath], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });

        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr || `Browser login exited with code ${code}`));
        });
      });
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Browser login failed: ${formatError(error)}` }],
      };
    }

    config = loadConfig();
    sessionClient.setSession(config.sessionId, config.fsAnid, config.cookies);

    if (!isAuthenticated()) {
      return {
        content: [{ type: 'text', text: 'Browser login did not save a session cookie.' }],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: 'Browser login complete. Session saved to ~/.familysearch-mcp/config.json.',
        },
      ],
    };
  },
);

server.tool('get-current-user', 'Get information about the currently authenticated user', {}, async () => {
  if (!isAuthenticated()) {
    return { content: [{ type: 'text', text: authRequiredText() }] };
  }

  try {
    const user = await sessionClient.validateSession({
      displayName: config.userDisplayName,
      personId: config.userPersonId,
    });
    config.userDisplayName = user.displayName;
    config.userPersonId = user.personId;
    persistConfig();

    return {
      content: [
        {
          type: 'text',
          text: `Current user: ${user.displayName}\nPerson ID: ${user.personId || 'Unknown'}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error fetching user info: ${formatError(error)}` }],
    };
  }
});

server.tool(
  'search-persons',
  'Search for person records in FamilySearch',
  {
    name: z.string().optional().describe('Full name (split into given name + surname when givenName/surname are omitted)'),
    givenName: z.string().optional().describe('Given name(s); preferred over "name" for exact control'),
    surname: z.string().optional().describe('Surname/last name; preferred over "name" for exact control'),
    birthDate: z.string().optional().describe('Birth date (YYYY-MM-DD)'),
    birthPlace: z.string().optional().describe('Birth place'),
    deathDate: z.string().optional().describe('Death date (YYYY-MM-DD)'),
    deathPlace: z.string().optional().describe('Death place'),
    gender: z.enum(['MALE', 'FEMALE']).optional().describe('Gender'),
    limit: z.number().optional().describe('Maximum number of results (default: 10)'),
    offset: z.number().optional().describe('Result offset for pagination (default: 0)'),
  },
  async (params) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const persons = await sessionClient.searchPersons(params);
      if (!persons.length) {
        return { content: [{ type: 'text', text: 'No persons found matching your search criteria.' }] };
      }

      const resultsText = persons
        .map(
          (person, index) =>
            `${index + 1}. ${person.name} (${person.id})\n   Gender: ${person.gender}\n   Birth: ${person.birth}\n   Death: ${person.death}`,
        )
        .join('\n\n');

      return {
        content: [{ type: 'text', text: `Found ${persons.length} matching records:\n\n${resultsText}` }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error searching persons: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-person',
  'Get detailed information about a specific person',
  {
    personId: z.string().describe('Person ID'),
  },
  async ({ personId }: { personId: string }) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const { card, notes, family } = await sessionClient.getPersonDetails(personId);
      const gender = card.gender || card.genderConclusion?.details?.gender || 'Unknown';
      const { birth, death } = formatCardBirthDeath(card);

      const lines = [
        'Person Details:',
        `ID: ${personId}`,
        `Name: ${card.name || 'Unknown'}`,
        `Gender: ${gender}`,
        `Lifespan: ${card.lifespan || 'Unknown'}`,
        `Birth: ${birth}`,
        `Death: ${death}`,
      ];

      const parents = new Set<string>();
      for (const group of family.parents || []) {
        if (group.parent1) parents.add(formatPersonSummary(group.parent1));
        if (group.parent2) parents.add(formatPersonSummary(group.parent2));
      }
      if (parents.size) {
        lines.push('', `Parents:\n${[...parents].map((p) => `  - ${p}`).join('\n')}`);
      }

      const spouseLines: string[] = [];
      for (const group of family.spouses || []) {
        const spouse = group.spouse1?.id === personId ? group.spouse2 : group.spouse1;
        if (spouse) {
          spouseLines.push(`  - ${formatPersonSummary(spouse)}`);
          for (const child of group.children || []) {
            spouseLines.push(`      child: ${formatPersonSummary(child)}`);
          }
        }
      }
      if (spouseLines.length) {
        lines.push('', `Spouses & children:\n${spouseLines.join('\n')}`);
      }

      const noteTexts = notes.map(formatNote).filter((note): note is string => Boolean(note));
      if (noteTexts.length) {
        lines.push('', `Notes:\n${noteTexts.map((note) => `  - ${note}`).join('\n')}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error fetching person details: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-ancestors',
  'Get ancestors of a specific person',
  {
    personId: z.string().describe('Person ID'),
    generations: z.number().optional().describe('Number of generations (default: 4, max: 8)'),
  },
  async ({ personId, generations = 4 }: { personId: string; generations?: number }) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const lines = await sessionClient.getAncestors(personId, generations);
      return {
        content: [
          {
            type: 'text',
            text: `Ancestors (${Math.min(generations || 4, 8)} generations):\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error fetching ancestors: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-descendants',
  'Get descendants of a specific person',
  {
    personId: z.string().describe('Person ID'),
    generations: z.number().optional().describe('Number of generations (default: 2, max: 3)'),
  },
  async ({ personId, generations = 2 }: { personId: string; generations?: number }) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const lines = await sessionClient.getDescendants(personId, generations);
      return {
        content: [
          {
            type: 'text',
            text: `Descendants (${Math.min(generations || 2, 3)} generations):\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error fetching descendants: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'search-records',
  'Search for historical records in FamilySearch',
  {
    givenName: z.string().optional().describe('Given name'),
    surname: z.string().optional().describe('Surname/last name'),
    birthDate: z.string().optional().describe('Birth date from (YYYY-MM-DD)'),
    birthDateTo: z.string().optional().describe('Birth date to (YYYY-MM-DD)'),
    birthPlace: z.string().optional().describe('Birth place'),
    deathDate: z.string().optional().describe('Death date from (YYYY-MM-DD)'),
    deathDateTo: z.string().optional().describe('Death date to (YYYY-MM-DD)'),
    deathPlace: z.string().optional().describe('Death place'),
    gender: z.enum(['MALE', 'FEMALE']).optional().describe('Gender'),
    collectionId: z.string().optional().describe('Specific collection ID to search in'),
    limit: z.number().optional().describe('Maximum number of results (default: 10)'),
    offset: z.number().optional().describe('Result offset for pagination (default: 0)'),
  },
  async (params) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const records = await sessionClient.searchRecords(params);
      if (!records.length) {
        return { content: [{ type: 'text', text: 'No records found matching your search criteria.' }] };
      }

      const resultsText = records
        .map(
          (record, index) =>
            `${index + 1}. ${record.name} (${record.id})\n   Gender: ${record.gender}\n   Birth: ${record.birth}\n   Death: ${record.death}\n   Collection: ${record.collection}` +
            (record.ark ? `\n   Record: ${record.ark}` : ''),
        )
        .join('\n\n');

      return {
        content: [{ type: 'text', text: `Found ${records.length} matching records:\n\n${resultsText}` }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error searching records: ${formatError(error)}` }] };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('FamilySearch server is running');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
