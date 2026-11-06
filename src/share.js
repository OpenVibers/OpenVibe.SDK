'use strict';
module.exports = { ...require('./share/store'), ...require('./share/schema'), ...require('./share/client'),
    ...require('./share/openapi'), ShareError: require('./share/validation').ShareError };
