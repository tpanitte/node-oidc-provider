const instance = require('../helpers/weak_cache');
const bodyParser = require('../shared/selective_body');
const noCache = require('../shared/no_cache');
const paramsMiddleware = require('../shared/assemble_params');
const presence = require('../helpers/validate_presence');
const { InvalidRequest, InvalidClient } = require('../helpers/errors');

const PARAM_LIST = new Set(['client_id', 'origin']);

module.exports = {
  get: async function checkSessionIframe(ctx, next) {
    const removeHeaders = !instance(ctx.oidc.provider).configuration('features.sessionManagement.keepHeaders');
    if (removeHeaders) {
      ctx.response.remove('X-Frame-Options');
      const csp = ctx.response.get('Content-Security-Policy');
      if (csp.includes('frame-ancestors')) {
        ctx.response.set('Content-Security-Policy', csp.replace(/ ?frame-ancestors [^;]+;/, ''));
      }
    }

    ctx.type = 'html';
    ctx.body = `<!DOCTYPE html>
<html>
<head lang="en">
<meta charset="UTF-8">
<title>Session Management - OP iframe</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jsSHA/2.3.1/sha256.js" integrity="sha256-NyuvLfsvfCfE+ceV6/W19H+qVp3M8c9FzAgj72CW39w=" crossorigin="anonymous"></script>
<script src="https://cdn.polyfill.io/v2/polyfill.min.js?features=fetch&rum=0"></script>
</head>
<body>

<script type="application/javascript">
(function () {
var originCheckResult;

function calculate(clientId, origin, actual, salt, cb) {
  try {
    if (originCheckResult.clientId !== clientId || originCheckResult.origin !== origin) {
      throw new Error('client_id and/or origin mismatch');
    }
    var opbs = getOPBrowserState(clientId);
    var stat = 'changed';

    if (opbs) {
      var shaObj = new jsSHA('SHA-256', 'TEXT');
      shaObj.update(clientId + ' ' + origin + ' ' + opbs + (salt ? ' ' + salt : ''));
      var expected = shaObj.getHash('HEX') + (salt ? ('.' + salt) : '');

      if (actual === expected) {
        stat = 'unchanged';
      }

      cb(stat);
    } else if ('hasStorageAccess' in document) {
      document.hasStorageAccess().then(function (hasAccess) {
        if (!hasAccess) {
          cb('error');
        } else {
          cb(stat);
        }
      }, cb.bind(undefined, 'error'));
    } else {
      cb(stat);
    }
  } catch (err) {
    cb('error');
  }
}

function check(clientId, origin, actual, salt, cb) {
  if (!originCheckResult) {
    fetch(location.pathname, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ client_id: clientId, origin: origin }),
      redirect: 'error',
    }).then(function (response) {
      if (response.ok) {
        originCheckResult = {
          origin: origin,
          clientId: clientId,
        };
        calculate(clientId, origin, actual, salt, cb);
      } else {
        throw new Error('invalid client_id and/or origin');
      }
    }).catch(cb.bind(undefined, 'error'));
  } else {
    calculate(clientId, origin, actual, salt, cb);
  }
}

function receiveMessage(e) {
  if (typeof e.data !== 'string') {
    return;
  }
  var parts = e.data.split(' ');
  var clientId = parts[0];
  var actual = parts[1];
  if (parts.length !== 2 || !clientId || !actual) {
    return;
  }
  var actualParts = actual.split('.');
  var sessionStr = actualParts[0];
  var salt = actualParts[1];
  if (!sessionStr || actualParts.length > 2) {
    return;
  }
  check(clientId, e.origin, actual, salt, function (stat) {
    e.source.postMessage(stat, e.origin);
  });
}

function getOPBrowserState(clientId) {
  var cookie = readCookie('${ctx.oidc.provider.cookieName('state')}.' + clientId);
  return cookie;
}

function readCookie(name) {
  var nameEQ = name + '=';
  var ca = document.cookie.split(';');
  for (var i=0; i < ca.length; i++) {
    var c = ca[i];
    while (c.charAt(0) === ' ') c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
}

window.addEventListener('message', receiveMessage, false);
})();
</script>

</body>
</html>`;
    await next();
  },
  post: [
    noCache,
    bodyParser.bind(undefined, 'application/json'),
    paramsMiddleware.bind(undefined, PARAM_LIST),
    async function checkClientOrigin(ctx, next) {
      presence(ctx, 'origin', 'client_id');
      const { client_id: clientId, origin } = ctx.oidc.params;
      [clientId, origin].forEach((value) => {
        if (typeof value !== 'string') {
          throw new InvalidRequest('only string parameter values are expected');
        }
      });
      const client = await ctx.oidc.provider.Client.find(clientId);
      ctx.oidc.entity('Client', client);
      if (!client) {
        throw new InvalidClient();
      }
      if (!client.originAllowed(origin)) {
        throw new InvalidRequest('origin not allowed', 403);
      }
      ctx.status = 204;
      await next();
    },
  ],
};
