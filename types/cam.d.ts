/**
 * openvibe-sdk/cam: the <ov-camera> element from OpenVibe.Cam.
 *
 * The element is defined by https://openvibe.cam/embed/ov-camera.js (or a self-hosted copy); this module
 * injects it and gives the attributes, events and methods a type.
 */

/** The embed script the loader injects when no `src` is given. */
export declare const OV_CAMERA_SRC: string;
/** The pinned in-page recorder script and its SHA-384 integrity value. */
export declare const CAM_KIT_SRC: string;
export declare const CAM_KIT_SRI: string;
export interface CamSettings {
    facing: 'user' | 'environment';
    lens: string;
    mic: string;
    resolution: '480' | '720' | '1080';
    mirror: boolean;
    updated_at: string | null;
}
export declare const settings: {
    get(options: { token: string }): Promise<CamSettings>;
    put(options: { token: string; values: Partial<Omit<CamSettings, 'updated_at'>> }): Promise<CamSettings>;
};

export type CamKitMode = 'video' | 'photo' | 'screen';
export interface CamKitResult {
    file: File;
    mode: CamKitMode;
    mimeType: string;
    duration: number;
    width: number;
    height: number;
    maxSeconds: number;
}
export interface CamKitOptions {
    mode?: CamKitMode;
    maxSeconds?: number;
    timer?: 0 | 3 | 10;
    onDone?: (result: CamKitResult) => void | Promise<void>;
}
/** Load OpenVibeCam once and return its browser API. */
export declare function loadCamKit(): Promise<{ open(options?: CamKitOptions): Promise<CamKitResult | null> }>;
/** Open Cam on this page and return a file after Use this; cancellation resolves to null. */
export declare function open(options?: CamKitOptions): Promise<CamKitResult | null>;

/** `camera` (video and microphone), `camera_only`, or `mic_only`; the default is `camera`. */
export type CaptureMode = 'camera' | 'camera_only' | 'mic_only';
/** What to open through the site's own OVCapture; every choice is optional. */
export interface CaptureOptions {
    mode?: CaptureMode;
    /** The front (`user`) or back (`environment`) camera. */
    facing?: 'user' | 'environment';
    /** A camera's id from `OVCapture.devices()`; it is asked for exactly. */
    lens?: string;
    /** A microphone's id from `OVCapture.devices()`; it is asked for exactly. */
    mic?: string;
    resolution?: '480' | '720' | '1080' | number;
    audio?: boolean;
    video?: boolean;
}
/**
 * Load the calling site's own `/shared/ov-capture.js` once and call `OVCapture.open(options)`.
 * The site must serve the shared capture core (every OpenVibe site does).
 */
export declare function capture(options?: CaptureOptions): Promise<MediaStream>;

/** The front camera (`user`) or the back camera (`environment`). */
export type OvCameraFacing = 'user' | 'environment';

/** The filters the element knows; `filters` is a comma list of these names. */
export type OvCameraFilter = 'none' | 'mono' | 'warm' | 'cool' | 'fade' | 'vivid' | 'blur';

/** A countdown before the capture: off, three seconds or ten. */
export type OvCameraTimer = 0 | 3 | 10;

/** One photo, or a burst of three 450 ms apart. */
export type OvCameraMode = 'photo' | 'burst';

/** `off` keeps every picture in the page; `openvibe` posts to Cam, only on openvibe.cam and signed in. */
export type OvCameraUpload = 'off' | 'openvibe';

/** The attributes on the tag. Every one is optional; the defaults are in the comment. */
export interface OvCameraAttributes {
    /** `user` (the front camera, the default) or `environment` (the back camera). */
    facing?: OvCameraFacing;
    /** A comma list of {@link OvCameraFilter} names; unknown names are dropped and an empty list is `none`. */
    filters?: string;
    /** A countdown in seconds; anything other than 0, 3 or 10 is 0. Default 0. */
    timer?: OvCameraTimer | '0' | '3' | '10';
    /** Default `photo`. */
    mode?: OvCameraMode;
    /** Default `off`: the blob is only delivered as an event. */
    upload?: OvCameraUpload;
}

/** The `detail` of `ov-camera:capture`, and what `capture()` resolves to. */
export interface OvCameraCaptureDetail {
    /** The encoded picture (`image/jpeg`, quality 0.92). */
    blob: Blob;
    width: number;
    height: number;
    /** The selected filter name ({@link OvCameraFilter}). */
    filter: string;
}

export type OvCameraErrorCode =
    | 'camera_unavailable'
    | 'permission_denied'
    | 'not_started'
    | 'capture_failed'
    | 'file_unreadable'
    | 'upload_unavailable'
    | 'upload_denied'
    | 'upload_failed';

/** The `detail` of `ov-camera:error`. */
export interface OvCameraErrorDetail {
    code: OvCameraErrorCode;
    message: string;
}

export interface OvCameraCaptureEvent extends CustomEvent<OvCameraCaptureDetail> {
    type: 'ov-camera:capture';
}

export interface OvCameraErrorEvent extends CustomEvent<OvCameraErrorDetail> {
    type: 'ov-camera:error';
}

/** The events the element fires, both bubbling out of its shadow root. */
export interface OvCameraEventMap {
    'ov-camera:capture': OvCameraCaptureEvent;
    'ov-camera:error': OvCameraErrorEvent;
}

/** The element itself, as `customElements.get('ov-camera')` returns it. */
export interface OvCameraElement extends HTMLElement {
    /** Ask for the camera. It is never called on connect; a click is the safe place to call it. */
    start(): Promise<void>;
    /** Stop every track and show the off card again. */
    stop(): void;
    /** Take a photo through the shutter path, honouring `timer` and `mode`; null when there is no camera. */
    capture(): Promise<OvCameraCaptureDetail | OvCameraCaptureDetail[] | null>;
    /** Switch front/back and restart the camera if it is on; resolves to the new facing. */
    flip(): Promise<OvCameraFacing>;
    addEventListener<K extends keyof OvCameraEventMap>(
        type: K,
        listener: (this: OvCameraElement, ev: OvCameraEventMap[K]) => void,
        options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
    ): void;
}

export interface DefineOvCameraOptions {
    /** The embed script to inject; defaults to {@link OV_CAMERA_SRC}. */
    src?: string;
}

/**
 * Inject the element's script once and resolve to its class. A second call reuses the load; a page that
 * already defines <ov-camera> resolves without a new tag.
 */
export declare function defineOvCamera(options?: DefineOvCameraOptions): Promise<CustomElementConstructor>;

declare global {
    interface HTMLElementTagNameMap {
        'ov-camera': OvCameraElement;
    }
}
