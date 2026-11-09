/** openvibe-sdk/git: OpenVibe.Git — repositories, browsing, contents writes, clone tokens and the three ways to a computer. */
type Opts = { signal?: AbortSignal };
type GitJson = Record<string, any>;
export type GitScope = 'git.repo.read' | 'git.repo.write';
export type GitSort = 'trending' | 'pushed' | 'stars' | 'new';
export type GitStarter = 'empty' | 'app' | 'static';

export interface GitRepo {
    id: string;
    owner: { username: string; subject?: string | null; display_name?: string | null; avatar_url?: string | null };
    name: string;
    full_name: string;
    description: string;
    visibility: 'public' | 'private';
    default_branch: string;
    topics: string[];
    stars: number;
    watchers: number;
    forks: number;
    language: string | null;
    languages: Record<string, number>;
    html_url: string;
    clone_url: string;
    mirror: { url: string; state: 'ready' | 'syncing' | 'error'; last_synced_at: string | null; error: string | null } | null;
    github: { full_name: string; html_url: string; stars: number; open_issues: number; open_pull_requests: number; ci_state: 'success' | 'failure' | 'pending' | 'unknown'; fetched_at: string } | null;
    created_at: string;
    updated_at: string;
    pushed_at?: string | null;
}

export interface GitRepos {
    list(params?: { q?: string; language?: string; official?: boolean; mirror?: boolean; mine?: boolean; starred?: boolean; sort?: GitSort; limit?: number; cursor?: string } & Opts): Promise<{ repositories: GitRepo[]; next_cursor: string | null }>;
    get(full: string, opts?: Opts): Promise<GitRepo>;
    create(fields: { name: string; description?: string; visibility?: 'public' | 'private'; topics?: string[]; starter?: GitStarter; mirror_url?: string }, opts?: Opts): Promise<GitRepo>;
    tree(full: string, opts?: { ref?: string; path?: string } & Opts): Promise<GitJson>;
    blob(full: string, opts: { ref?: string; path: string } & Opts): Promise<GitJson>;
    raw(full: string, opts: { ref?: string; path: string } & Opts): Promise<string>;
    commits(full: string, opts?: { ref?: string; path?: string; limit?: number; cursor?: string } & Opts): Promise<{ commits: GitJson[]; next_cursor: string | null }>;
    commit(full: string, sha: string, opts?: { diff?: boolean } & Opts): Promise<GitJson>;
    branches(full: string, opts?: Opts): Promise<GitJson>;
    tags(full: string, opts?: Opts): Promise<GitJson>;
    releases(full: string, opts?: Opts): Promise<GitJson>;
    contributors(full: string, opts?: Opts): Promise<GitJson>;
    insights(full: string, opts?: { days?: number } & Opts): Promise<GitJson>;
    star(full: string, on?: boolean, opts?: Opts): Promise<GitJson>;
    mirror(full: string, fields?: { push_url?: string | null; push_token?: string | null }, opts?: Opts): Promise<GitJson>;
}

export interface GitClient {
    changes: {
        list(full: string, opts?: Opts): Promise<GitJson>;
        get(full: string, number: number | string, opts?: Opts): Promise<GitJson>;
        create(full: string, input: { title: string; body?: string; base_ref: string; head_ref: string; source_repo?: string }, opts?: Opts): Promise<GitJson>;
        comment(full: string, number: number | string, input: { head_sha: string; path: string; line: number; side: 'old' | 'new'; message: string }, opts?: Opts): Promise<GitJson>;
        approve(full: string, number: number | string, headSha: string, opts?: Opts): Promise<GitJson>;
        merge(full: string, number: number | string, input: { head_sha: string; method?: 'merge' | 'squash' | 'rebase' }, opts?: Opts): Promise<GitJson>;
        close(full: string, number: number | string, opts?: Opts): Promise<GitJson>;
        summary(full: string, number: number | string, headSha: string, opts?: Opts): Promise<GitJson>;
    };
    issues: {
        list(full: string, opts?: Opts): Promise<GitJson>;
        get(full: string, number: number | string, opts?: Opts): Promise<GitJson>;
        create(full: string, input: { title: string; body?: string }, opts?: Opts): Promise<GitJson>;
        labels(full: string, number: number | string, labels: string[], opts?: Opts): Promise<GitJson>;
        close(full: string, number: number | string, opts?: Opts): Promise<GitJson>;
    };
    compare(full: string, base: string, head: string, opts?: Opts): Promise<GitJson>;
    blame(full: string, ref: string, path: string, opts?: Opts): Promise<GitJson>;
    search(full: string, query: string, opts?: Opts): Promise<GitJson>;
    reviewModel(full: string, model: string, opts?: Opts): Promise<GitJson>;
    repos: GitRepos;
    commits: {
        create(full: string, fields: { branch: string; message: string; files: { path: string; content: string; encoding?: 'utf8' | 'base64' }[]; base?: string; author?: { name: string; email: string } }, opts?: Opts): Promise<GitJson>;
    };
    tokens: {
        create(fields?: { scopes?: GitScope[]; hours?: number; label?: string }, opts?: Opts): Promise<{ token: string; token_type: string; expires_at: string; scopes: GitScope[]; clone_url: string; command: string }>;
    };
    clone(full: string, opts?: { to?: 'https' | 'link' | 'codes'; directory?: string; token?: string }): { repo: string; url: string; command?: string; href?: string };
}

export function createGitClient(client: { json(opts: Record<string, unknown>): Promise<any>; request(opts: Record<string, unknown>): Promise<{ data: any }> }, options?: { baseUrl?: string }): GitClient;
export const SCOPES: readonly GitScope[];
export const SORTS: readonly GitSort[];
export const STARTERS: readonly GitStarter[];
