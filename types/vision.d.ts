/** The audience a Vision token is minted for: `openvibe.vision`. */
export const DEFAULT_AUDIENCE: string;

/** An image as bytes, a data URL or a public URL. */
export type VisionImage = Blob | ArrayBuffer | ArrayBufferView | string;

export interface VisionReceipt {
    engine: 'local' | 'routed' | 'local+routed' | 'local+routed description';
    model: string | null;
    cost_usd: number;
    ms: number;
    confidence: number | null;
    retention: string;
}

export interface VisionAnswerRow {
    id: string;
    task: 'ask' | 'describe' | 'identify' | 'count' | 'translate' | 'ocr' | 'compare';
    question?: string | null;
    mode: 'auto' | 'local' | 'ai';
    source: 'upload' | 'url' | 'data';
    source_url?: string | null;
    image_sha256: string;
    image_mime: string;
    image_bytes: number;
    text: string | null;
    answer: Record<string, unknown>;
    model: string | null;
    provider: string | null;
    route: string | null;
    reason: string | null;
    engine?: string | null;
    confidence?: number | null;
    cost_usd: number;
    latency_ms: number;
    created_at: string;
}

export interface VisionCompareSample {
    engine: 'local' | 'ai';
    requested_model?: string | null;
    model?: string | null;
    provider?: string | null;
    route?: string | null;
    ok: boolean;
    text: string | null;
    cost_usd: number;
    latency_ms: number;
    error_code?: string | null;
}

export interface VisionAnswerResult {
    answer: VisionAnswerRow;
    compare?: VisionCompareSample[];
    local?: { ok: boolean; model: string | null; confidence: number | null; error_code: string | null };
}

export interface VisionConsent {
    id: string;
    feature: 'verify' | 'find' | 'cast' | 'library';
    scope: string;
    text_version: string;
    granted_at: string;
    revoked_at: string | null;
}

export interface VisionConsentGrant {
    feature: 'verify' | 'find' | 'cast' | 'library';
    scope: string;
    text_version: string;
    granted_at: string;
}

export interface VisionConsentRequest {
    signed_name: string;
    text_version: string;
    channel?: string;
    adult?: boolean;
    region?: string;
}

export interface VisionFaceTag {
    id: string;
    channel: string;
    media_ref: string;
    created_at: string;
}

export interface VisionFaceDetection {
    count: number;
    boxes: Array<{ x: number; y: number; width: number; height: number; score: number }>;
}

export interface VisionFaceLibraryGroup {
    id: string;
    media_id: string;
    group_id: string;
    label: string | null;
    excluded: boolean;
    created_at: string;
}

export interface VisionUiCheckFinding {
    kind: 'overflow' | 'cut_off' | 'contrast' | 'overlap' | 'layering';
    severity: 'high' | 'medium' | 'low';
    selector: string;
    detail: string;
    evidence?: Record<string, unknown>;
}

export interface VisionUiCheckResult {
    check: {
        id: string;
        source: 'html' | 'url' | 'screenshot';
        url?: string | null;
        image_sha256?: string | null;
        viewport: { w: number; h: number };
        engine: 'static-html' | 'screenshot';
        findings: VisionUiCheckFinding[];
        summary?: Record<string, unknown>;
        counts?: Record<string, number>;
        severity?: Record<string, number>;
        warnings?: string[];
        summary_text?: string;
        created_at: string;
    };
}

export interface VisionModels {
    ai: boolean;
    configured: string[];
    offered: unknown[];
    local: string[];
    note: string;
}

export interface VisionBenchmarks {
    count: number;
    benchmarks: Array<{
        task: string;
        engine: 'local' | 'ai';
        provider: string | null;
        model: string | null;
        samples: number;
        avg_latency_ms: number;
        avg_cost_usd: number;
        min_cost_usd: number;
        max_latency_ms: number;
    }>;
}

export interface VisionClientOptions {
    baseUrl?: string;
    audience?: string;
}

export interface VisionClient {
    ask(image: VisionImage, o?: { question?: string; task?: string; mode?: 'auto' | 'local' | 'ai'; lang?: string; model?: string }, opts?: { filename?: string; contentType?: string }): Promise<VisionAnswerResult>;
    describe(image: VisionImage, o?: { question?: string; task?: string; mode?: 'auto' | 'local' | 'ai'; lang?: string; model?: string }, opts?: { filename?: string; contentType?: string }): Promise<VisionAnswerResult>;
    ocr(image: VisionImage, o?: { lang?: string; fallback?: boolean; model?: string }, opts?: { filename?: string; contentType?: string }): Promise<VisionAnswerResult>;
    compare(image: VisionImage, o?: { task?: string; question?: string; models?: string[]; lang?: string }, opts?: { filename?: string; contentType?: string }): Promise<VisionAnswerResult>;
    alt(image: VisionImage, opts?: { filename?: string; contentType?: string }): Promise<{ answer: { alt_text: string; editable: true; receipt: VisionReceipt } }>;
    index(image: VisionImage, itemId: string, o?: { resultUrl?: string }, opts?: { filename?: string; contentType?: string }): Promise<{ answer: { item_id: string; receipt: VisionReceipt } }>;
    find(query: VisionImage, opts?: { filename?: string; contentType?: string }): Promise<{ answer: { results: Array<{ item_id: string; result_url: string | null; score: number }>; receipt: VisionReceipt } }>;
    receipt(image: VisionImage, o?: { fallback?: boolean }, opts?: { filename?: string; contentType?: string }): Promise<{ answer: { store: string | null; items: Array<{ name: string; qty: number; price: number }>; total: number | null; raw_text?: string; receipt: VisionReceipt } }>;
    product(image: VisionImage, o?: { allow_rerank?: boolean }, opts?: { filename?: string; contentType?: string }): Promise<{ answer: { description: string; embedding: number[]; offers: Array<{ source: string; title: string; url: string; price?: number | null; score?: number }>; warnings: string[]; receipt: VisionReceipt } }>;
    watch(image: VisionImage, classes: string[], o?: { previousImage?: string; sourceRef?: string }, opts?: { filename?: string; contentType?: string }): Promise<{ answer: { detections: Array<{ class: string; confidence: number; box?: { x: number; y: number; width: number; height: number } | null }>; receipt: VisionReceipt } }>;
    moments(frames: Array<{ timestamp_ms: number; image?: string; image_url?: string }>, prompts?: string[]): Promise<{ answer: { scene_changes: Array<{ timestamp_ms: number; kind: 'scene_change' }>; candidate_moments: Array<{ timestamp_ms: number; prompt: string; score: number }>; receipt: VisionReceipt } }>;
    uiCheck(source?: { html?: string; url?: string; image?: VisionImage; imageUrl?: string; viewport?: { w: number; h: number } }): Promise<VisionUiCheckResult>;
    models(): Promise<VisionModels>;
    benchmarks(o?: { task?: string; limit?: number }): Promise<VisionBenchmarks>;
    answer(id: string): Promise<VisionAnswerRow>;
    uiCheckById(id: string): Promise<VisionUiCheckResult>;
    mcp(message: unknown, o?: { protocolVersion?: string }): Promise<unknown>;
    protectedResource(): Promise<{ resource: string; authorization_servers: string[]; scopes_supported: string[]; bearer_methods_supported: string[]; resource_documentation?: string }>;
    face: {
        detect(image: VisionImage, opts?: { filename?: string; contentType?: string }): Promise<VisionFaceDetection>;
        blur(image: VisionImage, opts?: { filename?: string; contentType?: string }): Promise<{ bytes: ArrayBuffer; contentType: string | null; faceCount: number }>;
        texts(): Promise<Record<'verify' | 'find' | 'cast' | 'library', { version: string; text: string }>>;
        consents(): Promise<VisionConsent[]>;
        grant(feature: 'verify' | 'find' | 'cast' | 'library', body: VisionConsentRequest): Promise<VisionConsentGrant>;
        revoke(feature: string, o?: { channel?: string }): Promise<{ feature: string; scope: string; revoked_at: string; revoked_by: 'subject'; erased: true }>;
        enrol(feature: 'verify' | 'find' | 'cast', image: VisionImage, o?: { channel?: string }, opts?: { filename?: string; contentType?: string }): Promise<{ enrolled: true; feature: string; scope: string; liveness: 'not_checked' }>;
        verify(image: VisionImage, opts?: { filename?: string; contentType?: string }): Promise<{ score: number; match: boolean; threshold: number; liveness: 'not_checked' | 'checked' }>;
        upload(image: VisionImage, opts?: { filename?: string; contentType?: string }): Promise<{ id: string; private_link: string; face_count: number }>;
        media(id: string): Promise<{ bytes: ArrayBuffer; contentType: string | null }>;
        find(): Promise<{ results: Array<{ private_link: string; score: number }> }>;
        tags(): Promise<VisionFaceTag[]>;
        cluster(region: string): Promise<VisionFaceLibraryGroup[]>;
        groups(): Promise<VisionFaceLibraryGroup[]>;
        correct(action: 'exclude' | 'merge' | 'split', ids: string[]): Promise<{ action: 'exclude' | 'merge' | 'split'; updated: number }>;
    };
}

export function createVisionClient(client: unknown, options?: VisionClientOptions): VisionClient;
