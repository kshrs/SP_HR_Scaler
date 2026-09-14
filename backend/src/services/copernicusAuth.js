const axios = require('axios');

const CDSE_AUTH_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Checks if Copernicus CDSE OAuth credentials are provided
 */
function hasCopernicusCredentials() {
  return Boolean(
    process.env.CDSE_CLIENT_ID &&
    process.env.CDSE_CLIENT_SECRET &&
    process.env.CDSE_CLIENT_ID.trim() !== '' &&
    process.env.CDSE_CLIENT_SECRET.trim() !== ''
  );
}

/**
 * Obtains or refreshes the Copernicus OAuth Bearer Token
 */
async function getCopernicusAuthToken() {
  if (!hasCopernicusCredentials()) {
    return null;
  }

  const now = Date.now();
  // Return cached token if valid for at least 60 more seconds
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', process.env.CDSE_CLIENT_ID.trim());
    params.append('client_secret', process.env.CDSE_CLIENT_SECRET.trim());

    const response = await axios.post(CDSE_AUTH_URL, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10000,
    });

    const data = response.data;
    cachedToken = data.access_token;
    tokenExpiresAt = now + (data.expires_in || 3600) * 1000;
    console.log('[Copernicus Auth] Successfully acquired new CDSE OAuth Access Token');
    return cachedToken;
  } catch (err) {
    console.error('[Copernicus Auth Error] Failed to obtain token:', err.response?.data || err.message);
    return null;
  }
}

module.exports = {
  hasCopernicusCredentials,
  getCopernicusAuthToken,
};
