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
const downloadDocumentScriptPath = join(__dirname, '..', 'scripts', 'download-document.mjs');

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

function transcriptExcerpt(text: string, highlights: string[], maxLength = 700): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;

  const lower = normalized.toLocaleLowerCase();
  const matchIndex = highlights
    .map((highlight) => lower.indexOf(highlight.toLocaleLowerCase()))
    .find((index) => index >= 0) ?? 0;
  const start = Math.max(0, matchIndex - Math.floor(maxLength / 3));
  const end = Math.min(normalized.length, start + maxLength);
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`;
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

interface DocumentDownloadResult {
  imageId: string;
  format: string;
  outputPath: string;
  bytes: number;
  viewerUrl: string;
  highResolution: boolean;
}

async function downloadDocument(options: Record<string, unknown>): Promise<DocumentDownloadResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [downloadDocumentScriptPath, JSON.stringify(options)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Document download exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as DocumentDownloadResult);
      } catch {
        reject(new Error(`Document download returned invalid output: ${stdout.slice(0, 200)}`));
      }
    });
  });
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

server.tool(
  'search-full-text',
  'Search FamilySearch AI-generated full-text transcripts of unindexed document images',
  {
    keywords: z.string().optional().describe('Words or phrases anywhere in the OCR transcript; supports FamilySearch search syntax'),
    fullName: z.string().optional().describe('Person name to find in the document'),
    place: z.string().optional().describe('Place mentioned in or associated with the document'),
    yearFrom: z.number().int().min(1).max(3000).optional().describe('Earliest year'),
    yearTo: z.number().int().min(1).max(3000).optional().describe('Latest year'),
    imageGroupNumber: z.string().optional().describe('FamilySearch DGS/image group number'),
    collectionId: z.string().optional().describe('Restrict the search to a Full-Text collection ID'),
    limit: z.number().int().min(1).max(20).optional().describe('Maximum results (default: 5, max: 20)'),
    offset: z.number().int().min(0).optional().describe('Result offset for pagination (default: 0)'),
    includeFullTranscript: z.boolean().optional().describe('Return complete OCR text instead of an excerpt; use with a low limit'),
    matchMode: z.enum(['any', 'all', 'exact']).optional().describe('How multi-word keywords and names are matched: any (OR, default), all (AND), or exact phrase'),
  },
  async (params) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }
    if (!params.keywords && !params.fullName && !params.place && !params.imageGroupNumber && !params.collectionId) {
      return { content: [{ type: 'text', text: 'Provide at least one search term, place, DGS number, or collection ID.' }] };
    }
    if (params.yearFrom && params.yearTo && params.yearFrom > params.yearTo) {
      return { content: [{ type: 'text', text: 'yearFrom must be less than or equal to yearTo.' }] };
    }

    try {
      const results = await sessionClient.searchFullText(params);
      if (!results.entries.length) {
        return { content: [{ type: 'text', text: 'No full-text records found matching your search criteria.' }] };
      }

      const resultText = results.entries.map((entry, index) => {
        const transcript = params.includeFullTranscript
          ? entry.transcript
          : transcriptExcerpt(entry.transcript, entry.highlights);
        return [
          `${results.offset + index + 1}. ${entry.title}`,
          `   Image ID: ${entry.id}`,
          `   Collection: ${entry.collectionTitle || 'Unknown'}${entry.collectionId ? ` (${entry.collectionId})` : ''}`,
          `   Date: ${entry.recordDate}`,
          `   Place: ${entry.recordPlace}`,
          `   Type: ${entry.recordType}`,
          `   Scan: ${entry.sourceUrl || 'Unavailable'}`,
          `   OCR: ${transcript || 'No transcript returned'}`,
        ].join('\n');
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Found ${results.total} full-text records; showing ${results.entries.length} from offset ${results.offset}:\n\n${resultText}`,
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error searching full-text records: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'search-catalog',
  'Search the FamilySearch catalog for collections, films, image groups, books, and other holdings',
  {
    place: z.string().optional().describe('Place name'),
    keywords: z.string().optional().describe('Keywords across catalog metadata'),
    title: z.string().optional().describe('Words from the title'),
    author: z.string().optional().describe('Author or organization'),
    subject: z.string().optional().describe('Subject'),
    surname: z.string().optional().describe('Surname'),
    callNumber: z.string().optional().describe('Library call number'),
    filmNumber: z.string().optional().describe('Film, fiche, or DGS number; leading zeroes are accepted'),
    onlineOnly: z.boolean().optional().describe('Only return online material'),
    limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default: 10)'),
    offset: z.number().int().min(0).optional().describe('Result offset (default: 0)'),
  },
  async (params) => {
    if (!isAuthenticated()) return { content: [{ type: 'text', text: authRequiredText() }] };
    if (!Object.entries(params).some(([key, value]) => !['limit', 'offset', 'onlineOnly'].includes(key) && value)) {
      return { content: [{ type: 'text', text: 'Provide at least one catalog search field.' }] };
    }
    try {
      const results = await sessionClient.searchCatalog(params);
      if (!results.entries.length) return { content: [{ type: 'text', text: 'No matching catalog items found.' }] };
      const text = results.entries.map((entry, index) => [
        `${results.offset + index + 1}. ${entry.title}`,
        `   Catalog: ${entry.url || entry.identifier || 'Unknown'}`,
        entry.creators.length ? `   Author: ${entry.creators.join('; ')}` : '',
        entry.coverage.length ? `   Coverage: ${entry.coverage.join('; ')}` : '',
        entry.subjects.length ? `   Subjects: ${entry.subjects.join('; ')}` : '',
        entry.holdings.length ? `   Holdings: ${entry.holdings.join('; ')}` : '',
      ].filter(Boolean).join('\n')).join('\n\n');
      return { content: [{ type: 'text', text: `Found ${results.total} catalog items; showing ${results.entries.length}:\n\n${text}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error searching the catalog: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'list-film-images',
  'List addressable images in a FamilySearch film/image group (DGS), starting at a chosen image number',
  {
    dgs: z.string().regex(/^\d{1,9}$/).describe('FamilySearch DGS/image group number; leading zeroes are optional'),
    startImage: z.number().int().min(1).optional().describe('First image number (default: 1)'),
    limit: z.number().int().min(1).max(100).optional().describe('Number of images to list (default: 20, max: 100)'),
  },
  async (params: { dgs: string; startImage?: number; limit?: number }) => {
    if (!isAuthenticated()) return { content: [{ type: 'text', text: authRequiredText() }] };
    try {
      const images = await sessionClient.listFilmImages(params);
      if (!images.length) return { content: [{ type: 'text', text: 'No accessible images found at that DGS/image position.' }] };
      const text = images.map((entry) => [
        `${entry.imageNumber}. ${entry.locator}`,
        `   APID: ${entry.apid}`,
        `   Viewer: ${entry.arkUrl}`,
        `   Thumbnail: ${entry.thumbnailUrl}`,
      ].join('\n')).join('\n\n');
      return { content: [{ type: 'text', text: `Found ${images.length} accessible film images:\n\n${text}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error listing film images: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'download-document',
  'Download a FamilySearch record image as original high-resolution JPG or as a PDF through the official viewer',
  {
    imageId: z.string().optional().describe('FamilySearch 3:1 image ID or its ARK URL; alternatively use dgs plus imageNumber'),
    dgs: z.string().regex(/^\d{1,9}$/).optional().describe('DGS/image group number (use together with imageNumber)'),
    imageNumber: z.number().int().min(1).optional().describe('One-based image number within the DGS'),
    format: z.enum(['jpg', 'pdf-highlights', 'pdf-no-highlights']).optional().describe('jpg is the original high-resolution scan (default)'),
    outputDirectory: z.string().optional().describe('Destination directory (default: ~/Downloads/familysearch-mcp)'),
    fileName: z.string().optional().describe('Optional file name; unsafe path characters are removed and existing files are never overwritten'),
  },
  async (params) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }
    if (!params.imageId && !(params.dgs && params.imageNumber)) {
      return { content: [{ type: 'text', text: 'Provide imageId, or both dgs and imageNumber.' }] };
    }
    if (params.imageId && (params.dgs || params.imageNumber)) {
      return { content: [{ type: 'text', text: 'Use either imageId or dgs + imageNumber, not both.' }] };
    }
    if (params.dgs && params.format && params.format !== 'jpg') {
      return { content: [{ type: 'text', text: 'DGS + imageNumber downloads support JPG only; use a 3:1 ARK image ID for PDF.' }] };
    }
    try {
      const result = await downloadDocument(params);
      return {
        content: [{
          type: 'text',
          text: [
            'FamilySearch document downloaded.',
            `Image ID: ${result.imageId}`,
            `Format: ${result.format}${result.highResolution ? ' (original high resolution)' : ''}`,
            `Size: ${result.bytes} bytes`,
            `Saved to: ${result.outputPath}`,
            `Viewer: ${result.viewerUrl}`,
          ].join('\n'),
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error downloading document: ${formatError(error)}` }] };
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
