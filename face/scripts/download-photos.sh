#!/bin/bash
# Downloads all uploaded reference photos for a submission into a single zip.
# Usage: scripts/download-photos.sh <submission_id> [output.zip]
set -euo pipefail

SUBMISSION_ID="${1:?Usage: scripts/download-photos.sh <submission_id> [output.zip]}"
cd "$(dirname "$0")/.."
OUTPUT="${2:-photos-submission-${SUBMISSION_ID}.zip}"

set -a
source .env.local
set +a

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

PATHS=$(curl -s "$SUPABASE_URL/rest/v1/uploaded_photos?submission_id=eq.$SUBMISSION_ID&select=storage_path&order=created_at.asc" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" |
  python3 -c "import json,sys; [print(r['storage_path']) for r in json.load(sys.stdin)]")

if [ -z "$PATHS" ]; then
  echo "No photos found for submission $SUBMISSION_ID" >&2
  exit 1
fi

i=0
while IFS= read -r path; do
  i=$((i + 1))
  ext="${path##*.}"
  curl -s "$SUPABASE_URL/storage/v1/object/user-photos/$path" \
    -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
    -o "$TMPDIR/photo-$(printf '%02d' "$i").$ext"
done <<<"$PATHS"

rm -f "$OUTPUT"
(cd "$TMPDIR" && zip -q -r "$OLDPWD/$OUTPUT" .)
echo "Wrote $OUTPUT ($i photos)"
