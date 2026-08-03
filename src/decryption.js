// Ported from tidal_dl/decryption.py (itself from the RedSea project) using Node's built-in
// crypto instead of pycryptodome. HiFi/Master tracks are delivered with a per-track AES key
// wrapped in a "security token"; this unwraps it and then stream-decrypts the audio file.

const crypto = require('crypto');
const fs = require('fs');
const { pipeline } = require('stream/promises');

// Fixed master key baked into Tidal's own clients - not a secret we introduced.
const MASTER_KEY_B64 = 'UIlTTEMmmLfGowo/UC60x2H45W6MdGgTRfo/umg4754=';

function decryptSecurityToken(securityTokenB64) {
  const masterKey = Buffer.from(MASTER_KEY_B64, 'base64'); // 32 bytes -> AES-256
  const securityToken = Buffer.from(securityTokenB64, 'base64');

  const iv = securityToken.subarray(0, 16);
  const encrypted = securityToken.subarray(16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', masterKey, iv);
  decipher.setAutoPadding(false); // raw CBC decrypt, same as pycryptodome's AES.new(...).decrypt()
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  const key = decrypted.subarray(0, 16);
  const nonce = decrypted.subarray(16, 24);
  return { key, nonce };
}

async function decryptFile(srcPath, destPath, key, nonce) {
  // AES-CTR with a 64-bit counter: IV = 8-byte nonce + 8 zero bytes, incrementing as one
  // 128-bit big-endian counter - matches pycryptodome's Counter.new(64, prefix=nonce).
  const iv = Buffer.concat([nonce, Buffer.alloc(8, 0)]);
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv);

  await pipeline(fs.createReadStream(srcPath), decipher, fs.createWriteStream(destPath));
}

module.exports = { decryptSecurityToken, decryptFile };
