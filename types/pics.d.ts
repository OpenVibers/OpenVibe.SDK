export interface Picture { id: string; slug: string; title: string; description: string; width: number; height: number; listed: boolean; tags: string[]; links: { page: string; direct: string; thumb: string; markdown: string; html: string; bbcode: string }; likes?: number; views?: number; author?: string }
export interface GalleryQuery { sort?: 'popular' | 'new' | 'rising'; q?: string; tag?: string; cursor?: string; limit?: number }
export interface Upload { id: string; size: number; offset: number; expires_at: string; image_id: string | null }
export interface Album { id: string; slug: string; title: string; description: string; images?: Picture[] }
export interface PicsClient {
 gallery(query?: GalleryQuery): Promise<{ pictures: Picture[]; next: string | null; sort: string }>;
 get(id: string): Promise<Picture>;
 mine(query?: { before?: string; limit?: number }): Promise<{ images: Picture[]; next: string | null }>;
 update(slug: string, patch: { title?: string; description?: string; alt?: string }): Promise<Picture>;
 publish(slug: string, input: { listed: boolean; tags?: string[] }): Promise<Picture>;
 like(slug: string, liked?: boolean): Promise<{ likes: number; views: number }>;
 remove(slug: string): Promise<void>;
 uploads: { create(input: { size: number; content_type: string; name?: string; title?: string }): Promise<Upload>; get(id: string): Promise<Upload>; chunk(id: string, offset: number, bytes: Uint8Array): Promise<Upload>; complete(id: string): Promise<Picture>; cancel(id: string): Promise<void> };
 albums: { list(): Promise<{ albums: Album[] }>; create(input: { title: string; description?: string }): Promise<Album>; get(slug: string): Promise<Album>; add(slug: string, pictureSlug: string): Promise<unknown>; removeImage(slug: string, pictureSlug: string): Promise<void>; remove(slug: string): Promise<void> };
}
export function createPicsClient(client: { json(options: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): PicsClient;
