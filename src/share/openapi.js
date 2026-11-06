'use strict';
/** Merge paths into an adopting service's OpenAPI 3.1 document. */
function shareOpenApi() {
    const schema = name => ({ $ref: `https://openvibe.network/contracts/share/${name}.v1.json` });
    const response = name => ({ description: 'Sharing result (ids and access metadata only)', content: { 'application/json': { schema: schema(name) } } });
    const op = (id, result, request, status = '200') => ({ operationId: id, security: [{ bearerAuth: [] }],
        ...(request ? { requestBody: { required: true, content: { 'application/json': { schema: schema(request) } } } } : {}),
        responses: { [status]: response(result), '400': { description: 'Invalid request or unknown exact name (also share.slot_required, share.reseal_required, share.reseal_invalid, share.lock_public)' },
            '403': { description: 'Cross-site write refused (share.csrf)' },
            '404': { description: 'Not found (also unauthorized, no resource metadata)' },
            '409': { description: 'Inactive or conflicting transfer, a member key that changed (share.key_changed), a member with no locker key (share.no_key), a fixed lock (share.lock_fixed) or no re-seal storage (share.reseal_unavailable)' },
            '412': { description: 'If-Match revision is stale' }, '413': { description: 'Request too large (share.too_large)' }, '429': { description: 'Name lookup rate limit' } } });
    const parameters = ['kind', 'id'].map(name => ({ in: 'path', name, required: true, schema: { type: 'string' } }));
    const base = '/api/v1/{kind}/{id}/share';
    const paths = {
        [base]: { parameters, get: op('shareGet', 'share'), put: { ...op('shareUpdate', 'share', 'update-request'), parameters: [{ in: 'header', name: 'If-Match', schema: { type: 'string' } }] } },
        [base + '/requests']: { parameters, post: op('shareRequestAccess', 'access-request', 'access-request-create', '201') },
        [base + '/requests/{requestId}/dismiss']: { parameters: [...parameters, { in: 'path', name: 'requestId', required: true, schema: { type: 'string', format: 'uuid' } }],
            post: op('shareDismissRequest', 'share') },
        [base + '/transfer']: { parameters, post: op('shareTransfer', 'share', 'transfer-request', '201') },
        '/api/v1/shared-with-me': { get: { ...op('shareList', 'list-result'), parameters: [
            { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { in: 'query', name: 'cursor', schema: { type: 'string' } },
        ] } },
        '/api/v1/share/people': { get: { ...op('sharePeople', 'people-lookup'), parameters: [
            { in: 'query', name: 'name', required: true, schema: { type: 'string' } },
        ] } },
    };
    paths[base].get.responses['200'].headers = { ETag: { description: 'Revision for conditional PUT', schema: { type: 'string' } } };
    for (const action of ['accept', 'decline']) paths[base + '/transfer/' + action] = { parameters, post: op('shareTransfer' + action[0].toUpperCase() + action.slice(1), 'transfer', 'transfer-action-request') };
    paths[base + '/transfer/cancel'] = { parameters, post: op('shareTransferCancel', 'share', 'transfer-action-request') };
    return { openapi: '3.1.0', info: { title: 'OpenVibe Sharing', version: '1.0.0' }, paths,
        components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } };
}
module.exports = { shareOpenApi };
