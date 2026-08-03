const EMBEDDED_KEYS = {
  version: '1.0.1',
  keys: [
    {
      platform: 'Fire TV',
      formats: 'Normal/High/HiFi(No Master)',
      clientId: 'OmDtrzFgyVVL6uW56OnFA2COiabqm',
      clientSecret: 'zxen1r3pO0hgtOC7j6twMo9UAqngGrmRiWpV7QC1zJ8=',
      valid: false,
      from: 'Fokka-Engineering (https://github.com/Fokka-Engineering/libopenTIDAL)',
    },
    {
      platform: 'Fire TV',
      formats: 'Master-Only(Else Error)',
      clientId: '7m7Ap0JC9j1cOM3n',
      clientSecret: 'vRAdA108tlvkJpTsGZS8rGZ7xTlbJ0qaZ2K9saEzsgY=',
      valid: true,
      from: 'Dniel97 (https://github.com/Dniel97/RedSea)',
    },
    {
      platform: 'Android TV',
      formats: 'Normal/High/HiFi(No Master)',
      clientId: 'Pzd0ExNVHkyZLiYN',
      clientSecret: 'W7X6UvBaho+XOi1MUeCX6ewv2zTdSOV3Y7qC3p3675I=',
      valid: false,
      from: '',
    },
    {
      platform: 'TV',
      formats: 'Normal/High/HiFi/Master',
      clientId: '8SEZWa4J1NVC5U5Y',
      clientSecret: 'owUYDkxddz+9FpvGX24DlxECNtFEMBxipU0lBfrbq60=',
      valid: false,
      from: 'morguldir (https://github.com/morguldir/python-tidal)',
    },
    {
      platform: 'Android Auto',
      formats: 'Normal/High/HiFi/Master',
      clientId: 'zU4XHVVkc2tDPo4t',
      clientSecret: 'VJKhDFqJPqvsPVNBV6ukXTJmwlvbttP7wlMlrc72se4=',
      valid: true,
      from: '1nikolas (https://github.com/yaronzz/Tidal-Media-Downloader/pull/840)',
    },
  ],
};

let apiKeys = EMBEDDED_KEYS;

function getKeys() {
  return apiKeys.keys;
}

function isValid(key) {
  return key.valid === true || String(key.valid).toLowerCase() === 'true';
}

function getBestKey() {
  const keys = apiKeys.keys;
  const fullyCapable = keys.find((k) => isValid(k) && /normal/i.test(k.formats) && /master/i.test(k.formats));
  if (fullyCapable) return fullyCapable;
  const masterCapable = keys.find((k) => isValid(k) && /master/i.test(k.formats));
  if (masterCapable) return masterCapable;
  const anyValid = keys.find((k) => isValid(k));
  return anyValid || keys[0];
}

async function refreshFromGist() {
  try {
    const res = await fetch('https://api.github.com/gists/48d01f5a24b4b7b37f19443977c22cd6');
    if (!res.ok) return;
    const data = await res.json();
    const content = data?.files?.['tidal-api-key.json']?.content;
    if (!content) return;
    const parsed = JSON.parse(content);
    if (parsed?.keys?.length) apiKeys = parsed;
  } catch {
    return;
  }
}

module.exports = { getKeys, getBestKey, refreshFromGist };
