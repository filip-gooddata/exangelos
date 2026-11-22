# Teams validation provenance

## Teams desktop observations in 0.2

The connector resolves Teams manager databases by tenant, user and locale. The
public m365crawl source documents account-qualified database names, the
`replychains-2` message map, original arrival times, conversation metadata and
the construction of Teams message links. These formats informed the local
Python implementation and the synthetic LevelDB fixtures. See the pinned
[account parser](https://github.com/ourostack/m365crawl/blob/d07df5c68323c018575c35cf4590fe4b2c6fffb6/internal/teamsdesktop/names.go),
[store reader](https://github.com/ourostack/m365crawl/blob/d07df5c68323c018575c35cf4590fe4b2c6fffb6/internal/teamsdesktop/read.go)
and [record mapper](https://github.com/ourostack/m365crawl/blob/d07df5c68323c018575c35cf4590fe4b2c6fffb6/internal/teamsdesktop/map.go).
Microsoft documents [Teams chat and channel deep links](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-link-teams).

Version 0.2 retired the action and controlled probes from the runtime and
tooling. The manifest hashes below describe their historical promotion. The
current installed-release checks use synthetic caches and account partitions.
They exercise the decoder and delivery path. They do not establish current
sign-in, access to a server-side thread, live platform compatibility, or
support for every serializer and Teams account variant.

## Original decoder promotion

Source: implementation and synthetic tests promoted from a local development snapshot.

This promotion is source-derived provenance, not new live evidence. Only the six approved implementation modules and six associated synthetic test modules were promoted. Source files were not modified. Python tokenize COMMENT tokens were removed from destination copies only; trailing whitespace was removed; docstrings and ASTs are preserved. No app data, credentials, raw content, JSON snapshots or live_probe.py were copied.

## Manifest verification

- `snapshot.json` SHA256 `06e2abff68851e04439eb4c2a2b89af3eedec9a79ddffe374d2a8583232159bb`: 17/20 entries verified. Excluded entries: `check_current_store.py`, `live-evidence.json`, `live_probe.py`.
- `controlled-snapshot.json` SHA256 `f02662af47eba968fc4b3fd334c323b9107db154ec900fc2f9ae5083d0502951`: 6/6 entries verified. Excluded entries: none.

The three excluded baseline entries were not read or verified in this promotion; their listed digests are not fresh verification. Both manifest digests match those recorded in the inherited controlled review. `test_live_probe.py` was verified but intentionally excluded on parent instruction because its implementation is not promoted. Parent-owned `action_probe.py` and `test_action_probe.py` are outside this copy and test scope.

## Code digests

| File | Source SHA256 before comment removal | Transformed SHA256 |
| --- | --- | --- |
| `probe.py` | `7519ad9c2be048466acc8b22bffddfebfb2aa9d9c37152dd5b5ea9520d4d868b` | `cfa065eac119e24b23a693d0e24d9c22bc05d4bbab3f0e7335876c1a1fa3fa25` |
| `current_store.py` | `02056a69a4c5c1646543f35b401bfb82b7a60471b8b0704c0758586ae5bbb96f` | `45c39b349409b7c68ce56fba360dbc4b824482fa4b06edda87530977b91a8d16` |
| `idb_comparator.py` | `0b213fa2f5de8567c5e2e7c2d78ae4ce140b59258f3ba93d158b405adf74fc1a` | `1ab4002d88d054fd8aba1ad98fe45d3638ba2d23996ec63db5a980646d183135` |
| `serialization.py` | `1585284e4a05c2bb80e72999f4020f61e624ce781b7ae5a6a30f842a67d2eda1` | `add0a6ab263ec9828d444a95d3d39483dc6a0431a6b6ebd3085283ece6707594` |
| `semantics.py` | `09b00fe2c5f877a1df0cd1fc2d208eb2679d169bb51766622b1decaa106c6a92` | `09b00fe2c5f877a1df0cd1fc2d208eb2679d169bb51766622b1decaa106c6a92` |
| `controlled_probe.py` | `b0ae32bf9110098878a8a7c98e712292df986ca46bf45495ccee18471762423c` | `4b6fb419e13ac111fb2f721a2862ced3342093144bcf94282196bc469b2f813a` |
| `test_controlled_probe.py` | `0adc6a955db7e03030906437da06e0e4540273b7805ecb3bc4dc9805b3d1f6c2` | `0adc6a955db7e03030906437da06e0e4540273b7805ecb3bc4dc9805b3d1f6c2` |
| `test_current_store.py` | `896bee6a20f75abb5444fa886da78096e4322d5253f205998c29913786205801` | `a288b159329484350b9fc1609e587df832b14627c17a471de7e4426dbc681743` |
| `test_idb_comparator.py` | `1bcb6e2dc0ee6ee026df56735de7d72c19471eabf343eda5b6460f9d90fd9acd` | `1bcb6e2dc0ee6ee026df56735de7d72c19471eabf343eda5b6460f9d90fd9acd` |
| `test_probe.py` | `272823d5315f1a6c5feccb0f1e33d52dcc6be7f85dea01212ea1a281991aaef7` | `272823d5315f1a6c5feccb0f1e33d52dcc6be7f85dea01212ea1a281991aaef7` |
| `test_semantics.py` | `ab0c8e693b61c4d9b96cf35d9ae06c2ef736d1681d486a086c8c9b4ce9de50e4` | `ab0c8e693b61c4d9b96cf35d9ae06c2ef736d1681d486a086c8c9b4ce9de50e4` |
| `test_serialization.py` | `37901b97cae4bb358cc7e523665ab1f1b148cb32c77b53cd85aeee0772923c11` | `37901b97cae4bb358cc7e523665ab1f1b148cb32c77b53cd85aeee0772923c11` |

## Inherited review records

- `prior-review.md`: SHA256 `be5de6189faf10826259a8449b40d0d478724c9fbaf0133beed29b7037526ab8` (retained at SOURCE, not copied).
- `review-round1.md`: SHA256 `b5357175413bda968e18d2fceb32e5808bcd353d29c326350a448cfcf1536c9b` (retained at SOURCE, not copied).
- `review.md`: SHA256 `f30accde13dde6417d8ae0c289875658486f81a05f51c9bcb1fac7fa70401bb7` (retained at SOURCE, not copied).
- `controlled-review.md`: SHA256 `29dedec127d58efaa8cc7e36a5b8a62266d6709e06be34241d1e3c65d572de4c` (retained at SOURCE, not copied).

`review.md` reports PASS for the frozen baseline, resolving the prior registration-order finding. `controlled-review.md` reports PASS for the frozen additive two-observation prototype and inherits that baseline. These are inherited source reviews, not fresh reviews of the transformed destination or integration. Their historical test results are not new execution evidence. The controlled review records a non-blocking missing synthetic regression for private terminal echo setup/restoration.

Historical Git SHA `72ecabaa36b9a1533bacd06dfba78ff4334ab50d` in those reports predates the history rewrite. Old SHAs are invalid after rewrite and must not identify the current checkout; manifest and file hashes identify these ignored source artifacts. The current destination HEAD is recorded with the fresh test evidence.

Inherited limits remain: no production readiness, authoritative signed-in account binding, message-event/deletion proof, server freshness or writer-locked atomicity is established. Parent owns the new harness and integration review.

Fresh synthetic test results and execution scope: `.scratch/teams-copy-checks.md` in the destination workspace.

## Decoder development and public references

The Python storage and serialization readers were authored locally using public
format documentation and upstream implementation references. The LevelDB/Snappy
routines originated in the local storage probe; the current-store reader reuses
those routines and adds manifest/log reconstruction. The serialization reader
reuses the local Snappy routine and implements a bounded subset of V8 and Blink
serialization. The comparator and its synthetic vectors are reference-derived
from the Chromium sources listed in `../THIRD_PARTY_NOTICES`.

Development references include:

- [LevelDB table format](https://github.com/google/leveldb/blob/main/doc/table_format.md),
  [block builder](https://github.com/google/leveldb/blob/main/table/block_builder.cc)
  and [version edits](https://github.com/google/leveldb/blob/main/db/version_edit.cc).
- [Snappy format description](https://github.com/google/snappy/blob/main/format_description.txt).
- [V8 value serializer](https://github.com/v8/v8/blob/main/src/objects/value-serializer.cc).
- Chromium's [Blink deserializer](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/bindings/core/v8/serialization/v8_script_value_deserializer.cc),
  [trailer reader](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/bindings/core/v8/serialization/trailer_reader.h)
  and [IndexedDB value wrapping](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/indexeddb/idb_value_wrapping.cc).

These references describe both formats and upstream implementations; the local
readers are not claimed to be clean-room implementations. No imported third-party
Python decoder was identified in the reviewed development records. Format
compatibility alone does not establish copying.

The promotion hashes above identify the reviewed local snapshots. The four
decoder modules preserve their source ASTs after comment removal; no copyright
or licence comment was present in those source modules. Future transformations
must preserve legal notices. Historical upstream references used mutable branches
and do not identify exact upstream commits or the installed application's engine
revision. This provenance describes source development, not live compatibility,
runtime correctness or publication clearance.
