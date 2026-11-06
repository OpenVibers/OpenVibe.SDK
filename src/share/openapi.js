'use strict';
/** Merge paths into an adopting service's OpenAPI 3.1 document. */
function shareOpenApi() {
    const schema = name => ({ $ref: `https://openvibe.network/contracts/share/${name}.v1.json` });
    const response = name => ({ description: 'Sharing result (ids and access metadata only)', content: { 'application/json': { schema: schema(name) } } });
    const op = (id, result, request, status = '200') => ({ operationId: id, security: [{ bearerAuth: [] }],
        ...(request ? { requestBody: { required: true, content: { 'application/json': { schema: schema(request) } } } } : {}),
        responses: { [status]: response(result), '400': { description: 'Invalid request or unknown exact name' }, '404': { description: 'Not found (also unauthorized, no resource metadata)' },
            '409': { description: 'Inactive or conflicting transfer' }, '412': { description: 'If-Match revision is stale' }, '429': { description: 'Name lookup rate limit' } } });
    const parameters = ['kind', 'id'].map(name => ({ in: 'path', name, required: true, schema: { type: 'string' } }));
    const base = '/api/v1/{kind}/{id}/share';
    const paths = {
        [base]: { parameters, get: op('shareGet', 'share'), put: { ...op('shareUpdate', 'share', 'update-request'), parameters: [{ in: 'header', name: 'If-Match', schema: { type: 'string' } }] } },
        [base + '/requests']: { parameters, post: op('shareRequestAccess', 'access-request', 'access-request-create', '201') },
        [base + '/transfer']: { parameters, post: op('shareTransfer', 'transfer', 'transfer-request', '201') },
        '/api/v1/shared-with-me': { get: { ...op('shareList', 'list-result'), parameters: [
            { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { in: 'query', name: 'cursor', schema: { type: 'string' } },
        ] } },
    };
    paths[base].get.responses['200'].headers = { ETag: { description: 'Revision for conditional PUT', schema: { type: 'string' } } };
    for (const action of ['accept', 'decline', 'cancel']) paths[base + '/transfer/' + action] = { parameters, post: op('shareTransfer' + action[0].toUpperCase() + action.slice(1), 'transfer', 'transfer-action-request') };
    return { openapi: '3.1.0', info: { title: 'OpenVibe Sharing', version: '1.0.0' }, paths,
        components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } };
}
module.exports = { shareOpenApi };
