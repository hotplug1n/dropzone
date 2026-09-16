import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { SecurityError } from '../errors/downloader-errors.js';

const UNSAFE_RANGES = new Set([
  'unspecified',
  'broadcast',
  'multicast',
  'linkLocal',
  'loopback',
  'private',
  'reserved',
  'uniqueLocal',
  'carrierGradeNat',
]);

function isUnsafeAddress(address) {
  try {
    const addr = ipaddr.parse(address);
    const range = addr.range();
    return UNSAFE_RANGES.has(range);
  } catch {
    // If it can't even be parsed as an IP, treat it as unsafe rather than
    // silently allowing it through.
    return true;
  }
}

/**
 * Guards against SSRF: only http(s) URLs are allowed, and the resolved
 * IP address(es) of the hostname must not point to loopback, private,
 * link-local or other internal ranges. Used before downloading any URL
 * returned by the Cobalt-compatible API (tunnel/redirect targets), since
 * that API could be misconfigured, compromised, or malicious.
 *
 * @param {string} urlString
 */
export async function assertSafeRemoteUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (cause) {
    throw new SecurityError('URL is malformed', { context: { urlString }, cause });
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SecurityError('Only http(s) protocols are allowed for downloads', {
      context: { urlString, protocol: parsed.protocol },
    });
  }

  const hostname = parsed.hostname;

  // Literal IP address in the URL (e.g. http://127.0.0.1/x)
  if (ipaddr.isValid(hostname)) {
    if (isUnsafeAddress(hostname)) {
      throw new SecurityError('URL points to a disallowed IP range', {
        context: { urlString, hostname },
      });
    }
    return;
  }

  if (hostname === 'localhost') {
    throw new SecurityError('URL points to localhost', { context: { urlString } });
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw new SecurityError('Could not resolve hostname', { context: { urlString, hostname }, cause });
  }

  if (!records || records.length === 0) {
    throw new SecurityError('Hostname resolved to no addresses', { context: { urlString, hostname } });
  }

  for (const { address } of records) {
    if (isUnsafeAddress(address)) {
      throw new SecurityError('URL resolves to a disallowed IP range', {
        context: { urlString, hostname, address },
      });
    }
  }
}
