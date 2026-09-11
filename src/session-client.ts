const BASE_URL = 'https://www.familysearch.org';

export class FamilySearchSessionError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'FamilySearchSessionError';
  }
}

interface CardEventDetails {
  date?: { originalText?: string; localizedText?: string };
  place?: { originalText?: string; localizedText?: string };
}

interface CardEvent {
  details?: CardEventDetails;
}

export interface PersonCard {
  id?: string;
  name?: string;
  gender?: string;
  lifespan?: string;
  birth?: CardEvent;
  death?: CardEvent;
  living?: boolean;
  mePersonCisId?: string;
  genderConclusion?: { details?: { gender?: string } };
}

export function formatCardEvent(event?: CardEvent): { date?: string; place?: string } {
  return {
    date: event?.details?.date?.localizedText || event?.details?.date?.originalText,
    place: event?.details?.place?.localizedText || event?.details?.place?.originalText,
  };
}

export function formatCardBirthDeath(card: PersonCard): { birth: string; death: string } {
  const birthDetails = formatCardEvent(card.birth);
  const birth =
    birthDetails.date || birthDetails.place
      ? `${birthDetails.date || 'Unknown date'} - ${birthDetails.place || 'Unknown place'}`
      : 'Unknown';

  if (card.living) {
    return { birth, death: 'Living' };
  }

  const deathDetails = formatCardEvent(card.death);
  const death =
    deathDetails.date || deathDetails.place
      ? `${deathDetails.date || 'Unknown date'} - ${deathDetails.place || 'Unknown place'}`
      : 'Unknown';

  return { birth, death };
}

interface GedcomxName {
  nameForms?: Array<{ fullText?: string }>;
}

interface GedcomxFact {
  type?: string;
  date?: { original?: string };
  place?: { original?: string };
}

interface GedcomxPerson {
  gender?: { type?: string };
  names?: GedcomxName[];
  facts?: GedcomxFact[];
  sources?: Array<{ description?: string }>;
}

interface SourceDescription {
  id?: string;
  about?: string;
  titles?: Array<{ value?: string }>;
  collection?: { title?: string };
  resourceType?: string;
}

interface HrPersonasResponse {
  entries?: Array<{
    id?: string;
    title?: string;
    content?: {
      gedcomx?: {
        description?: string | { title?: string };
        persons?: GedcomxPerson[];
        sourceDescriptions?: SourceDescription[];
      };
    };
  }>;
  gedcomx?: { sourceDescriptions?: SourceDescription[] };
}

export interface HistoricalRecordResult {
  id: string;
  name: string;
  gender: string;
  birth: string;
  death: string;
  collection: string;
  ark: string;
  url: string;
  sourceDescriptionId: string;
}

function extractRecords(data: HrPersonasResponse): HistoricalRecordResult[] {
  const globalSources = data.gedcomx?.sourceDescriptions || [];

  return (data.entries || []).map((record) => {
    const gedcomx = record.content?.gedcomx;
    const primaryPerson = gedcomx?.persons?.[0];
    const birthFact = primaryPerson?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Birth');
    const deathFact = primaryPerson?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Death');

    const sources = [...(gedcomx?.sourceDescriptions || []), ...globalSources];
    const sourceRef = primaryPerson?.sources?.[0]?.description?.replace(/^#/, '');
    const source = sources.find((entry) => entry.id === sourceRef) || sources[0];
    const ark = source?.about || '';
    const sourceTitle = source?.titles?.[0]?.value;
    const descriptionTitle =
      typeof gedcomx?.description === 'object' ? gedcomx?.description?.title : undefined;
    const collection = source?.collection?.title || descriptionTitle || sourceTitle || 'Unknown collection';

    return {
      id: record.id || 'Unknown',
      name: primaryPerson?.names?.[0]?.nameForms?.[0]?.fullText || record.title || 'Unknown',
      gender: primaryPerson?.gender?.type?.replace('http://gedcomx.org/', '') || 'Unknown',
      birth: birthFact
        ? `${birthFact.date?.original || 'Unknown date'} - ${birthFact.place?.original || 'Unknown place'}`
        : 'Unknown',
      death: deathFact
        ? `${deathFact.date?.original || 'Unknown date'} - ${deathFact.place?.original || 'Unknown place'}`
        : 'Unknown',
      collection,
      ark,
      url: ark,
      sourceDescriptionId: source?.id || '',
    };
  });
}

export interface SessionClientOptions {
  sessionId?: string;
  fsAnid?: string;
  cookies?: string;
  minIntervalMs?: number;
  maxRetries?: number;
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

const BROWSER_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://www.familysearch.org',
  Referer: 'https://www.familysearch.org/en/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'sec-ch-ua': '"Chromium";v="144", "Not(A:Brand";v="24", "Google Chrome";v="144"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'User-Agent': BROWSER_USER_AGENT,
};

const DEFAULT_MIN_INTERVAL_MS = 1100;
const DEFAULT_MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasErrorCode(data: unknown, code: string): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'errorCode' in data &&
    String((data as { errorCode?: string | number }).errorCode) === code
  );
}

function isUnauthorized(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'status' in data &&
    (data as { status?: string }).status === 'UNAUTHORIZED'
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export class FamilySearchSessionClient {
  private cookies: string;
  private minIntervalMs: number;
  private maxRetries: number;
  private lastRequestAt = 0;

  constructor(options: SessionClientOptions) {
    this.cookies = options.cookies || buildCookieHeader(options.sessionId, options.fsAnid);
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  isAuthenticated(): boolean {
    return Boolean(this.cookies);
  }

  setSession(sessionId: string, fsAnid?: string, cookies?: string): void {
    this.cookies = cookies || buildCookieHeader(sessionId, fsAnid);
  }

  private cookieHeader(): string {
    return this.cookies;
  }

  private async throttle(): Promise<void> {
    const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) {
      await sleep(wait);
    }
    this.lastRequestAt = Date.now();
  }

  private backoffMs(attempt: number): number {
    return Math.min(500 * 2 ** attempt, 8000);
  }

  private async request<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    if (!this.cookies) {
      throw new FamilySearchSessionError('Not authenticated. Set a browser session cookie first.');
    }

    const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.throttle();

      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            ...BROWSER_HEADERS,
            Cookie: this.cookieHeader(),
          },
        });
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) {
          await sleep(this.backoffMs(attempt));
          continue;
        }
        throw new FamilySearchSessionError(
          `Network error contacting ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new FamilySearchSessionError(
          `Invalid JSON response (${response.status}) from ${path}: ${text.slice(0, 200)}`,
          response.status,
        );
      }

      // FamilySearch-specific errors are handled before the generic !response.ok
      // branch, because they arrive with a non-2xx status that would otherwise
      // mask the useful message. Error 15 is a hard bot-protection block: do not
      // retry it, as hammering only prolongs the block.
      if (hasErrorCode(data, '15')) {
        throw new FamilySearchSessionError(
          'Request blocked by FamilySearch security (error 15). Re-run login-with-browser to refresh cookies and wait a few minutes before retrying.',
          403,
        );
      }

      if (isUnauthorized(data)) {
        throw new FamilySearchSessionError(String((data as { message?: string }).message || 'Session expired'), 401);
      }

      if (!response.ok) {
        const rawMessage =
          typeof data === 'object' &&
          data !== null &&
          ('message' in data ? String((data as { message?: string }).message) : JSON.stringify(data));
        const message = typeof rawMessage === 'string' ? rawMessage : '';

        if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
          lastError = new FamilySearchSessionError(message, response.status);
          await sleep(this.backoffMs(attempt));
          continue;
        }

        throw new FamilySearchSessionError(message || `Request failed with status ${response.status}`, response.status);
      }

      return data as T;
    }

    throw lastError instanceof Error
      ? lastError
      : new FamilySearchSessionError(`Request to ${path} failed after ${this.maxRetries + 1} attempts`);
  }

  async validateSession(fallback?: {
    displayName?: string;
    personId?: string;
  }): Promise<{ displayName: string; personId: string; cisId: string }> {
    if (fallback?.personId) {
      try {
        const person = await this.getPersonCard(fallback.personId);
        return {
          displayName: person.name || fallback.displayName || 'Authenticated FamilySearch user',
          personId: fallback.personId,
          cisId: person.mePersonCisId || '',
        };
      } catch {
        // Fall through to search-based validation.
      }
    }
    const data = await this.request<{
      entries?: Array<{
        content?: {
          gedcomx?: {
            persons?: Array<{
              id?: string;
              names?: Array<{ nameForms?: Array<{ fullText?: string }> }>;
            }>;
          };
        };
      }>;
    }>('/service/search/tree/v2/personas', {
      count: 1,
      offset: 0,
      'q.givenName': 'John',
      'q.surname': 'Smith',
    });

    if (!data.entries?.length) {
      throw new FamilySearchSessionError('Session cookie is invalid or expired', 401);
    }

    return {
      displayName: fallback?.displayName || 'Authenticated FamilySearch user',
      personId: fallback?.personId || '',
      cisId: '',
    };
  }

  async searchPersons(params: {
    name?: string;
    givenName?: string;
    surname?: string;
    birthDate?: string;
    birthPlace?: string;
    deathDate?: string;
    deathPlace?: string;
    gender?: 'MALE' | 'FEMALE';
    limit?: number;
    offset?: number;
  }) {
    const query: Record<string, string | number> = {
      count: params.limit || 10,
      offset: params.offset || 0,
      'm.defaultFacets': 'on',
    };

    if (params.givenName) query['q.givenName'] = params.givenName;
    if (params.surname) query['q.surname'] = params.surname;

    if (!params.givenName && !params.surname && params.name) {
      const parts = params.name.trim().split(/\s+/);
      if (parts.length === 1) {
        query['q.surname'] = parts[0];
      } else {
        query['q.givenName'] = parts.slice(0, -1).join(' ');
        query['q.surname'] = parts[parts.length - 1];
      }
    }

    if (params.birthDate) query['q.birthLikeDate.from'] = params.birthDate;
    if (params.birthPlace) query['q.birthLikePlace'] = params.birthPlace;
    if (params.deathDate) query['q.deathLikeDate.from'] = params.deathDate;
    if (params.deathPlace) query['q.deathLikePlace'] = params.deathPlace;
    if (params.gender) query['q.sex'] = params.gender === 'MALE' ? 'Male' : 'Female';

    const data = await this.request<{
      entries?: Array<{
        id?: string;
        title?: string;
        content?: {
          gedcomx?: {
            persons?: Array<{
              gender?: { type?: string };
              names?: Array<{ nameForms?: Array<{ fullText?: string }> }>;
              facts?: Array<{
                type?: string;
                date?: { original?: string };
                place?: { original?: string };
              }>;
            }>;
          };
        };
      }>;
    }>('/service/search/tree/v2/personas', query);

    return (data.entries || []).map((entry) => {
      const person = entry.content?.gedcomx?.persons?.[0];
      const birthEvent = person?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Birth');
      const deathEvent = person?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Death');

      return {
        id: entry.id || 'Unknown',
        name: person?.names?.[0]?.nameForms?.[0]?.fullText || entry.title || 'Unknown',
        gender: person?.gender?.type?.replace('http://gedcomx.org/', '') || 'Unknown',
        birth: birthEvent
          ? `${birthEvent.date?.original || 'Unknown date'} - ${birthEvent.place?.original || 'Unknown place'}`
          : 'Unknown',
        death: deathEvent
          ? `${deathEvent.date?.original || 'Unknown date'} - ${deathEvent.place?.original || 'Unknown place'}`
          : 'Unknown',
      };
    });
  }

  async getPersonCard(personId: string): Promise<PersonCard> {
    return this.request<PersonCard>(`/service/tree/tree-data/v8/person/${personId}/card`, { treeId: 'PRIVATE' });
  }

  async getPersonDetails(personId: string) {
    const [card, notes, family] = await Promise.all([
      this.getPersonCard(personId),
      this.request<{ notes?: unknown[] }>(`/service/tree/tree-data/v8/person/${personId}/notes/all`).catch(() => ({ notes: [] })),
      this.getFamilyMembers(personId).catch(() => ({} as FamilyMembersResponse)),
    ]);

    return { card, notes: notes.notes || [], family };
  }

  async getFamilyMembers(personId: string): Promise<FamilyMembersResponse> {
    return this.request<FamilyMembersResponse>(`/service/tree/tree-data/r9/family-members/person/${personId}`, {
      includePhotos: true,
      treeId: 'PRIVATE',
    });
  }

  async getAncestors(personId: string, generations = 4) {
    const gens = Math.min(Math.max(generations, 1), 8);
    const data = await this.request<{ ancestors?: AncestorGeneration[][] }>(
      `/service/tree/tree-data/r9/portrait-pedigree/${personId}`,
      {
        numGenerations: gens,
        treeId: 'PRIVATE',
        includePhotos: false,
        includeTempleRollupStatus: false,
        includeFullHasSiblings: true,
        includeRecordHints: false,
        includeSpouseAncestry: false,
      },
    );

    const lines: string[] = [];
    const seen = new Set<string>([personId]);
    const formatPerson = (person?: PersonSummary) => {
      if (!person) return 'Unknown';
      const year = person.lifespan?.match(/\d{4}/)?.[0] || person.birth?.date?.match(/\d{4}/)?.[0] || '?';
      return `${person.name || 'Unknown'} (${year}) [${person.id || '?'}]`;
    };
    const addAncestor = (person: PersonSummary | undefined, generation: number) => {
      if (!person?.id || seen.has(person.id)) return;
      seen.add(person.id);
      const prefix = '  '.repeat(generation);
      const relation = person.gender === 'FEMALE' ? 'Mother' : person.gender === 'MALE' ? 'Father' : 'Ancestor';
      lines.push(`${prefix}${relation}: ${formatPerson(person)}`);
    };

    if (!data.ancestors?.length) {
      return [`No ancestors found for person ${personId}`];
    }

    const rootCouple = data.ancestors[0]?.[0];
    const rootPerson = rootCouple?.parent1?.id === personId ? rootCouple.parent1 : rootCouple?.parent2;
    lines.push(`Root: ${formatPerson(rootPerson || { id: personId, name: 'Unknown' })}`);

    for (let generation = 1; generation < data.ancestors.length; generation++) {
      const couples = data.ancestors[generation] || [];
      for (const couple of couples) {
        addAncestor(couple.parent1, generation);
        addAncestor(couple.parent2, generation);
      }
    }

    return lines;
  }

  async getDescendants(personId: string, generations = 2) {
    const gens = Math.min(Math.max(generations, 1), 3);
    const lines: string[] = [];
    const visited = new Set<string>();

    const formatPerson = (person?: PersonSummary) => {
      if (!person) return 'Unknown';
      const year = person.lifespan?.match(/\d{4}/)?.[0] || '?';
      return `${person.name || 'Unknown'} (${year}) [${person.id || '?'}]`;
    };

    const walk = async (currentId: string, depth: number, prefix: string) => {
      if (depth > gens || visited.has(currentId)) return;
      visited.add(currentId);

      const family = await this.getFamilyMembers(currentId);
      const children = new Map<string, PersonSummary>();

      for (const spouseGroup of family.spouses || []) {
        for (const child of spouseGroup.children || []) {
          if (child.id) children.set(child.id, child);
        }
      }

      for (const parentGroup of family.parents || []) {
        for (const child of parentGroup.children || []) {
          if (child.id && child.id !== currentId) children.set(child.id, child);
        }
      }

      for (const child of children.values()) {
        lines.push(`${prefix}Child: ${formatPerson(child)}`);
        if (depth < gens && child.id) {
          await walk(child.id, depth + 1, prefix + '  ');
        }
      }
    };

    const root = await this.getPersonCard(personId);
    lines.push(`Root: ${formatPerson({ id: personId, name: root.name, lifespan: root.lifespan })}`);
    await walk(personId, 1, '');

    if (lines.length === 1) {
      lines.push('  No descendants found.');
    }

    return lines;
  }

  async searchRecords(params: {
    givenName?: string;
    surname?: string;
    birthDate?: string;
    birthDateTo?: string;
    birthPlace?: string;
    deathDate?: string;
    deathDateTo?: string;
    deathPlace?: string;
    gender?: 'MALE' | 'FEMALE';
    collectionId?: string;
    limit?: number;
    offset?: number;
  }): Promise<HistoricalRecordResult[]> {
    const query: Record<string, string | number> = {
      count: params.limit || 10,
      offset: params.offset || 0,
      'm.defaultFacets': 'on',
      'm.facetNestCollectionInCategory': 'on',
      'm.queryRequireDefault': 'on',
    };

    if (params.givenName) query['q.givenName'] = params.givenName;
    if (params.surname) query['q.surname'] = params.surname;
    if (params.birthDate) query['q.birthLikeDate.from'] = params.birthDate;
    if (params.birthDateTo) query['q.birthLikeDate.to'] = params.birthDateTo;
    if (params.birthPlace) query['q.birthLikePlace'] = params.birthPlace;
    if (params.deathDate) query['q.deathLikeDate.from'] = params.deathDate;
    if (params.deathDateTo) query['q.deathLikeDate.to'] = params.deathDateTo;
    if (params.deathPlace) query['q.deathLikePlace'] = params.deathPlace;
    if (params.gender) query['q.sex'] = params.gender === 'MALE' ? 'Male' : 'Female';
    if (params.collectionId) query['f.collectionId'] = params.collectionId;

    const data = await this.request<HrPersonasResponse>('/service/search/hr/v2/personas', query);
    return extractRecords(data);
  }
}

export interface PersonSummary {
  id?: string;
  name?: string;
  gender?: string;
  lifespan?: string;
  birth?: { date?: string; place?: string };
}

export interface FamilyMembersResponse {
  parents?: Array<{
    parent1?: PersonSummary;
    parent2?: PersonSummary;
    children?: PersonSummary[];
  }>;
  spouses?: Array<{
    spouse1?: PersonSummary;
    spouse2?: PersonSummary;
    children?: PersonSummary[];
    event?: { details?: { date?: { original?: string }; place?: { localizedText?: string } } };
  }>;
}

interface AncestorGeneration {
  parent1?: PersonSummary;
  parent2?: PersonSummary;
}

export function formatPersonSummary(person?: PersonSummary): string {
  if (!person) return 'Unknown';
  const year =
    person.lifespan?.match(/\d{4}/)?.[0] || person.birth?.date?.match(/\d{4}/)?.[0] || '?';
  return `${person.name || 'Unknown'} (${year}) [${person.id || '?'}]`;
}

function buildCookieHeader(sessionId?: string, fsAnid?: string): string {
  const parts: string[] = [];
  if (sessionId) parts.push(`fssessionid=${sessionId}`);
  if (fsAnid) parts.push(`fs_anid=${fsAnid}`);
  return parts.join('; ');
}
