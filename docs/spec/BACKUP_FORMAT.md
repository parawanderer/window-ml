# The `.wmlbak` file format, version 1

An encrypted, compressed SQLite file: the archive folder's month files and the one-off backup. This document is
enough to write a reader in another language. The design, and why it is shaped this way, is
[`docs/dev/backup.md`](../dev/backup.md); the reference implementation is `src/backup/backup-format.ts`, and
`tools/wmlbak-decrypt.mjs` is a standalone reader.

## The three forms of a file

Told apart by the first bytes, never by the name.

| Form | First bytes | Holds |
| --- | --- | --- |
| plain | `53 51 4C 69 74 65 20 66 6F 72 6D 61 74 20 33 00` (`SQLite format 3\0`) | a SQLite database |
| compressed | `1F 8B` | gzip of a SQLite database |
| encrypted | `57 4D 4C 42 41 4B 00` (`WMLBAK\0`) | this format |

## Layout of an encrypted file

```
offset 0   8 bytes   magic: "WMLBAK", 0x00, version byte 0x01
offset 8   4 bytes   header length H, unsigned 32-bit little-endian
offset 12  H bytes   header: UTF-8 JSON
offset 12+H          body: one or more frames
frame                4 bytes ciphertext length N (u32 LE), then N bytes of ciphertext (AES-256-GCM output, 16-byte tag last)
```

The PREFIX is the first `12 + H` bytes (magic, length, header exactly as stored). It is the associated data (AAD) of
every chunk, so any edit to it fails every chunk. Read the header's bytes as they are; never re-serialise the JSON to
build the AAD.

### Header

```json
{"v":1,"kind":"backup","created":"2026-10-23T00:00:00.000Z","compression":"gzip","chunk":1048576,
 "fileSalt":"<base64, 32 bytes>","keyId":"<16 hex>",
 "wraps":[
  {"by":"passphrase","kdf":{"alg":"argon2id","m":65536,"t":3,"p":1},"salt":"<base64, 16>","iv":"<base64, 12>","ct":"<base64, 48>"},
  {"by":"recovery","kdf":{"alg":"hkdf-sha256"},"salt":"<base64, 16>","iv":"<base64, 12>","ct":"<base64, 48>"}]}
```

| Field | Meaning |
| --- | --- |
| `v` | format version, `1`. A reader refuses any other value, and a magic version byte other than `0x01` |
| `kind` | `"backup"` or `"archive-month"`; informational |
| `created` | ISO 8601 UTC time of writing; informational |
| `compression` | `"gzip"` is the only value; refuse another |
| `chunk` | plaintext bytes per chunk, 1 to 67108864 (64 MiB). Take it from the header |
| `fileSalt` | base64 of 32 random bytes, new for every file |
| `keyId` | hex of the first 8 bytes of `HKDF-SHA256(ikm = data key, salt = empty, info = "wmlbak v1 key id")`; names the data key so a reader can say "wrong key" early. Not secret |
| `wraps` | the data key sealed under each secret that opens the file; any one is enough |

Argon2id `m` is in KiB (`65536` is 64 MiB), `t` is passes, `p` is lanes. READERS MUST USE THE HEADER'S PARAMETERS, not
constants: the cost may be raised later, and files already written keep theirs. A reader may refuse a cost far beyond
any real one (the reference reader refuses `m` over 1 GiB, `t` over 64, `p` over 16) so a hostile file cannot make it
allocate without bound.

## Keys

The **data key** is 32 random bytes, one per install. It is never stored in the clear; the browser holds it only as a
non-extractable `CryptoKey`, and the headers carry it wrapped.

**Wraps.** Each wrap is `AES-256-GCM(key = KEK, iv, plaintext = the 32-byte data key, AAD = "wmlbak v1 wrap " + by)`;
`ct` is the 32-byte ciphertext with its 16-byte tag (48 bytes) and `iv` is 12 random bytes. The KEK, 32 bytes, is:

- `by = "passphrase"`: `Argon2id(password = UTF-8 of the passphrase after Unicode NFC normalisation, salt, m, t, p,
  output = 32 bytes)`, Argon2 version 0x13 (the RFC 9106 default), no secret and no associated data.
- `by = "recovery"`: `HKDF-SHA256(ikm = the 16 recovery-key bytes, salt = the wrap's salt, info = "wmlbak v1 wrap
  recovery", length = 32)`. A fast KDF is enough because the key has 128 random bits.

**The recovery key** is 16 random bytes. For people it is written as 28 characters of Crockford base32 (alphabet
`0123456789ABCDEFGHJKMNPQRSTVWXYZ`) in 7 groups of 4 joined by `-`, for example `CP00-058T-BSTQ-PZYS-83W9-6XXA-0M65`:

1. The first 26 characters encode the 16 bytes big-endian, 5 bits per character, 130 bits with the last 2 bits zero.
2. The last 2 characters are a checksum: take the first 10 bits of `SHA-256(the 16 bytes)` (byte 0, then the top 2 bits of
   byte 1), and write them as two 5-bit characters.
3. Reading is tolerant: upper-case the input, drop spaces and dashes, read `I` and `L` as `1` and `O` as `0`. After
   that the length must be 28, every character in the alphabet, the 2 padding bits zero, and the checksum right.

**Per-file key.** `HKDF-SHA256(ikm = data key, salt = fileSalt, info = "wmlbak v1 file", length = 32)` is the AES-256-GCM
key of that file. Because every file has its own key, chunk nonces restart at zero in each and never repeat under one key.

## Body

1. The plaintext is the SQLite file. Compress it as a single gzip stream.
2. Cut the gzip bytes into chunks of `chunk` bytes; the last may be shorter. An empty input still gives a gzip stream
   (at least 20 bytes), so there is always at least one chunk. A gzip length that is an exact multiple of `chunk` has
   no extra empty chunk.
3. Chunk `i` (from 0) is encrypted with AES-256-GCM, the per-file key, AAD = the prefix, and the 12-byte nonce: the
   index `i` as an 11-byte big-endian integer, then one byte, `0x01` for the final chunk and `0x00` for every other.
4. Each ciphertext (chunk length + 16) is written as a frame: its length as u32 LE, then the bytes.

## Reading

1. Check the magic and version byte, read `H`, take the prefix, parse the header.
2. Find a wrap the secret opens (derive the KEK from the wrap's own parameters, decrypt with its AAD). A wrong secret
   fails the tag; try the next wrap of the right `by`. Optionally compare `keyId`.
3. Derive the per-file key. Walk the frames: a frame is the FINAL one exactly when it ends at the end of the file. Use
   nonce flag `1` for it and `0` for the others, decrypt with the prefix as AAD.
4. Concatenate the plaintext chunks, gunzip, and only then output anything.

A reader MUST reject, and MUST NOT return or write partial plaintext for: an unknown version, a header it cannot parse,
a missing final chunk (a truncated file fails because its new last chunk was written with flag `0`), data after the
final chunk (the real final chunk is then read with flag `0` and fails), a frame length above `chunk + 16` or below 16,
a file with no frames, and any authentication failure. The reference reader reports truncation, extension and edits as
one error where the tag is what fails, since the cause cannot be told apart from outside.

## The standalone decryptor

`tools/wmlbak-decrypt.mjs` depends only on Node 20 or later and `hash-wasm`, and imports nothing from the extension.
To use it on a machine that has neither the repository nor the extension:

```
curl -O https://raw.githubusercontent.com/parawanderer/window-ml/main/tools/wmlbak-decrypt.mjs
npm install hash-wasm
node wmlbak-decrypt.mjs 2026-10.wmlbak 2026-10.sqlite          # asks for the passphrase
node wmlbak-decrypt.mjs 2026-10.wmlbak 2026-10.sqlite --recovery-key   # asks for the recovery key
```

The secret is typed at a prompt, not given as an argument, so it stays out of shell history. The output is the plain
SQLite file, which opens in any SQLite tool; nothing is written unless every chunk authenticates.

## Test vectors

`tests/fixtures/backup/v1-sample.wmlbak` is a committed version-1 file at the real Argon2 cost (passphrase and recovery
key are in `tests/backup-format.test.mjs`). It must decrypt forever; a change to this format is a new version byte, never
an edit of this one.
