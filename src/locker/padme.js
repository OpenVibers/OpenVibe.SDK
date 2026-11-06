'use strict';
/**
 * Padmé padding (Nikitin et al., "Reducing Metadata Leakage from Encrypted Files and Network
 * Traffic", PoPETs 2019).
 *
 * The point of padding a locked item: the server must not learn how big it is. Rounding the size
 * up to a whole 1 MiB chunk says too much — a 200-byte note becomes a 1 MiB object, and every
 * item under a megabyte looks the same, which is a leak of its own.
 *
 * Padmé rounds the length up to the next size on a grid that gets finer as the length grows:
 *
 *     E = floor(log2(n))          the band the length is in
 *     S = floor(log2(E)) + 1      how many steps the band has
 *     d = 2^(E - S)               the step of the band
 *     P(n) = d * ceil(n / d)      the padded length
 *
 * The padded length is one of a small number of values per band, and the bands double, so the
 * number of possible padded lengths up to n grows like log(n): knowing the padded length says
 * O(log log n) bits about the real one. The expansion stays under 12% (the worst case is a
 * length just above a band boundary, 129 bytes padded to 144).
 *
 * The arithmetic is exact above 2^31: there are no 32-bit bitwise operators here, only
 * comparisons and division by a power of two, both exact on the doubles we have.
 */

/** The largest e with 2^e <= size: floor(log2(size)), without a logarithm. */
function exponentOf(size) {
    let e = 0;
    let power = 1;
    while (power * 2 <= size) { power *= 2; e++; }
    return e;
}

/**
 * The padded length of a content of this size: the smallest length on Padmé's grid that is not
 * smaller than it. Zero for zero, which the caller handles.
 */
function padme(size) {
    if (!Number.isInteger(size) || size <= 0) return 0;
    if (size === 1) return 1;
    const band = exponentOf(size);
    const steps = exponentOf(band) + 1;
    const step = Math.pow(2, band - steps);
    // Dividing by a power of two is exact, so the ceiling is the ceiling and not nearly it.
    return Math.ceil(size / step) * step;
}

module.exports = { padme, exponentOf };
