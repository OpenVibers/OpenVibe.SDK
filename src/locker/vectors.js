'use strict';
/**
 * The shared test vectors. The browser module (openvibe-shared/ov-locker.js) runs the same cases,
 * so both runtimes must produce the same bytes for the same input: the same header, the same
 * envelope, the same eight words.
 *
 * Everything here is fixed: the keys, the byte source and the content. The keys below are test
 * keys, made for this file and used for nothing else.
 */

/**
 * A fixed byte source: the same bytes every time, so a vector is the same on every runtime and
 * in every browser. It is a test helper, not a random source: never use it for anything real.
 */
function fixedRandom(seed = 0x1a2b3c4d) {
    let state = seed >>> 0;
    return (length) => {
        const out = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            state ^= state << 13; state >>>= 0;
            state ^= state >>> 17;
            state ^= state << 5; state >>>= 0;
            out[i] = state & 0xff;
        }
        return out;
    };
}

/** The content of every case. */
const CONTENT = "The quick brown fox jumps over the lazy dog.";

/** A person's keys, made for these vectors. */
const PERSON = {
    "ecdh": {
        "key_ops": [
            "deriveBits"
        ],
        "ext": true,
        "kty": "EC",
        "x": "pNngpTSE3X3C_CGzfpAtenjliLPFZ9arBVNtI0ctPXw",
        "y": "fXZT2JcDDiXEb6xH3LUrqlPakM3GQwe3aqbV_1vhVLI",
        "crv": "P-256",
        "d": "cG9YgmeoPeaI8lXZRpijV5--2sC4rYWSqWbyGCYKPu0"
    },
    "signing": {
        "key_ops": [
            "sign"
        ],
        "ext": true,
        "kty": "EC",
        "x": "ytN7TbH08BDhIld7Tt-8R80FoRosnzgTxSn75z135Gk",
        "y": "D0axhLHKheyPLSc4GW0PpSfM48FPCLcC4OiRn-ZqN1w",
        "crv": "P-256",
        "d": "fMd3QfF8zWlqrml-sgPHlQygx49XEW_FHWACSihxAEk"
    },
    "ecdhPublic": {
        "kty": "EC",
        "crv": "P-256",
        "x": "pNngpTSE3X3C_CGzfpAtenjliLPFZ9arBVNtI0ctPXw",
        "y": "fXZT2JcDDiXEb6xH3LUrqlPakM3GQwe3aqbV_1vhVLI"
    },
    "signingPublic": {
        "kty": "EC",
        "crv": "P-256",
        "x": "ytN7TbH08BDhIld7Tt-8R80FoRosnzgTxSn75z135Gk",
        "y": "D0axhLHKheyPLSc4GW0PpSfM48FPCLcC4OiRn-ZqN1w"
    },
    "fingerprint": "lichen brick plateau yew · apple petal rabbit sand"
};

/** The subject the people case is for. */
const SUBJECT = {
    "type": "user",
    "id": "usr_01JAB2C3D4E5F6G7H8J9K0MNPQ"
};

/** The cases: the same content, sealed three ways. */
const CASES = [
    {
        "name": "people",
        "envelope_sha256": "a07abdad22e7400831299bb6c363c50241c816bb49c361e555f90bd148690b47",
        "header": {
            "version": "locker.envelope.v1",
            "suite": "AES-256-GCM",
            "chunk_size": 1048576,
            "padded_size": 256,
            "nonce_base": "ghT0ZBfkXps=",
            "lock": "people",
            "slots": {
                "people": [
                    {
                        "subject": {
                            "type": "user",
                            "id": "usr_01JAB2C3D4E5F6G7H8J9K0MNPQ"
                        },
                        "algorithm": "ECDH-P256/HKDF-SHA256/AES-256-GCM",
                        "recipient_key": "TCGh2gH6HIuT0-A9Ge0jOTrFmRXWQkdA6fZG8JxikTA",
                        "ephemeral_public_key": {
                            "kty": "EC",
                            "crv": "P-256",
                            "x": "pNngpTSE3X3C_CGzfpAtenjliLPFZ9arBVNtI0ctPXw",
                            "y": "fXZT2JcDDiXEb6xH3LUrqlPakM3GQwe3aqbV_1vhVLI"
                        },
                        "salt": "pGphaA6OCYR5+nzvUl/WQQ==",
                        "nonce": "0uLZzrvm1lBfW87O",
                        "wrapped_key": "IpXVDIbStzw/kky7eKnrPQ7SOufRZ8zjU8iWB3c59OhfRjKLXuwDs4NQ4OlMAtGN"
                    }
                ]
            }
        }
    },
    {
        "name": "password",
        "envelope_sha256": "61f9d8f4ad38c4f2e4303f5a48f697e0903b41462f9b54351bb839dcbdc42c1b",
        "header": {
            "version": "locker.envelope.v1",
            "suite": "AES-256-GCM",
            "chunk_size": 1048576,
            "padded_size": 256,
            "nonce_base": "YXEf22DEcq8=",
            "lock": "password",
            "slots": {
                "password": {
                    "algorithm": "PBKDF2-SHA256/AES-256-GCM",
                    "kdf": "PBKDF2-SHA-256",
                    "iterations": 600000,
                    "salt": "jtNXQP80hz5f78yryNnM0w==",
                    "nonce": "onI04DQDAwHgUsR4",
                    "wrapped_key": "pnLvXu5bTR3lmWGT2GFfWc2v43dG67dM7lrStqWOPrL4f+SI6YivVWwXK0BvVjiR"
                }
            }
        }
    },
    {
        "name": "link",
        "envelope_sha256": "63cd81542d4994c05e3add3c4fcc819ebebc2b917fb4219c6070ecbea2337b54",
        "header": {
            "version": "locker.envelope.v1",
            "suite": "AES-256-GCM",
            "chunk_size": 1048576,
            "padded_size": 256,
            "nonce_base": "Rb2p0icJ0nY=",
            "lock": "link",
            "slots": {
                "link": {}
            }
        }
    }
];

/** A recovery phrase from a fixed byte source: the same words on every runtime. */
const RECOVERY = {
    "phrase": "whale robin orchid cricket olive jasmine dill clover kestrel night cypress arrow canyon opal shell coral indigo solar storm indigo forest comet desert melon",
    "words": [
        "whale",
        "robin",
        "orchid",
        "cricket",
        "olive",
        "jasmine",
        "dill",
        "clover",
        "kestrel",
        "night",
        "cypress",
        "arrow",
        "canyon",
        "opal",
        "shell",
        "coral",
        "indigo",
        "solar",
        "storm",
        "indigo",
        "forest",
        "comet",
        "desert",
        "melon"
    ]
};

/** What inspect() says about each case: the header, read without a key. */
const INSPECT = {
    "people": {
        "version": "locker.envelope.v1",
        "lock": "people",
        "padded_size": 256,
        "recipients": [
            "TCGh2gH6HIuT0-A9Ge0jOTrFmRXWQkdA6fZG8JxikTA"
        ],
        "iterations": null
    },
    "password": {
        "version": "locker.envelope.v1",
        "lock": "password",
        "padded_size": 256,
        "recipients": [],
        "iterations": 600000
    },
    "link": {
        "version": "locker.envelope.v1",
        "lock": "link",
        "padded_size": 256,
        "recipients": [],
        "iterations": null
    }
};

module.exports = { fixedRandom, CONTENT, PERSON, SUBJECT, CASES, RECOVERY, INSPECT };
