<?php
// Notesgood sync endpoint for PHP hosting (Hostinger shared hosting and the like).
//
// Setup: upload this file, and next to it a file `sync-key.txt` containing one secret line of your
// choosing (the deploy workflow writes it from the SYNC_KEY secret). Data is stored in ./sync-data/.
// In the app: Library → ⋯ → Sync, enter the URL of this file and the same secret.
//
// API (all requests carry the secret in the X-Sync-Key header):
//   GET  sync.php?a=pull&since=<rev>  → { rev, items: [{ k:'n'|'p'|'d', id, updated, rev, data? }] }
//   POST sync.php?a=push               ← { items: [{ k, id, updated, data? }] }  → { rev, skipped: [ids] }
//   GET  sync.php?a=blob&id=<id>       → raw bytes      PUT/POST sync.php?a=blob&id=<id> ← raw bytes
// Items are last-write-wins on `updated` (a client timestamp); `rev` is a server counter for pulls.

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Sync-Key, X-Blob-Type');
header('Cache-Control: no-store');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit;

$dir = __DIR__ . '/sync-data';
$keyFile = __DIR__ . '/sync-key.txt';

function fail(int $code, string $msg): never {
  http_response_code($code);
  header('Content-Type: application/json');
  echo json_encode(['error' => $msg]);
  exit;
}

if (!is_file($keyFile)) fail(500, 'sync-key.txt is missing next to sync.php');
$key = trim((string) file_get_contents($keyFile));
$given = $_SERVER['HTTP_X_SYNC_KEY'] ?? '';
if ($key === '' || !hash_equals($key, $given)) fail(401, 'Wrong sync key');

foreach (["$dir", "$dir/items", "$dir/blobs"] as $d) if (!is_dir($d) && !mkdir($d, 0750, true)) fail(500, "Cannot create $d");
if (!is_file("$dir/.htaccess")) file_put_contents("$dir/.htaccess", "Require all denied\n");

$safeId = fn(string $id) => preg_match('/^[A-Za-z0-9_-]{1,80}$/', $id) ? $id : fail(400, 'Bad id');
$action = $_GET['a'] ?? '';

/** Runs $fn with the index locked and loaded; writes it back if $fn returns true. */
function withIndex(string $dir, callable $fn) {
  $fh = fopen("$dir/index.json", 'c+');
  if (!$fh || !flock($fh, LOCK_EX)) fail(500, 'Cannot lock index');
  $raw = stream_get_contents($fh);
  $index = $raw ? json_decode($raw, true) : null;
  if (!is_array($index)) $index = ['rev' => 0, 'items' => []];
  $out = $fn($index);
  if ($out === true) {
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($index));
    fflush($fh);
  }
  flock($fh, LOCK_UN);
  fclose($fh);
  return $index;
}

if ($action === 'pull') {
  $since = (int) ($_GET['since'] ?? 0);
  $index = withIndex($dir, fn() => false);
  $items = [];
  foreach ($index['items'] as $id => $meta) {
    if ($meta['rev'] <= $since) continue;
    $item = ['k' => $meta['k'], 'id' => $id, 'updated' => $meta['updated'], 'rev' => $meta['rev']];
    if ($meta['k'] !== 'd') {
      $raw = @file_get_contents("$dir/items/$id.json");
      if ($raw === false) continue;
      $item['data'] = json_decode($raw);
    }
    $items[] = $item;
  }
  usort($items, fn($a, $b) => $a['rev'] <=> $b['rev']);
  header('Content-Type: application/json');
  echo json_encode(['rev' => $index['rev'], 'items' => $items]);
  exit;
}

if ($action === 'push') {
  $body = json_decode((string) file_get_contents('php://input'), true);
  if (!is_array($body) || !isset($body['items']) || !is_array($body['items'])) fail(400, 'Bad request');
  $skipped = [];
  $index = withIndex($dir, function (&$index) use ($body, $dir, $safeId, &$skipped) {
    foreach ($body['items'] as $it) {
      $id = $safeId((string) ($it['id'] ?? ''));
      $k = $it['k'] ?? '';
      if (!in_array($k, ['n', 'p', 'd'], true)) fail(400, 'Bad item kind');
      $updated = (float) ($it['updated'] ?? 0);
      $cur = $index['items'][$id] ?? null;
      // Someone else saved a newer version of this item: keep theirs, the client gets it on pull.
      if ($cur && $cur['updated'] > $updated) { $skipped[] = $id; continue; }
      $index['rev']++;
      $index['items'][$id] = ['k' => $k, 'updated' => $updated, 'rev' => $index['rev']];
      if ($k === 'd') @unlink("$dir/items/$id.json");
      else file_put_contents("$dir/items/$id.json", json_encode($it['data'] ?? null));
    }
    return true;
  });
  header('Content-Type: application/json');
  echo json_encode(['rev' => $index['rev'], 'skipped' => $skipped]);
  exit;
}

if ($action === 'blob') {
  $id = $safeId((string) ($_GET['id'] ?? ''));
  $path = "$dir/blobs/$id";
  if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    if (!is_file($path)) fail(404, 'No such blob');
    header('Content-Type: ' . (is_file("$path.type") ? trim(file_get_contents("$path.type")) : 'application/octet-stream'));
    header('Content-Length: ' . filesize($path));
    readfile($path);
    exit;
  }
  if ($_SERVER['REQUEST_METHOD'] === 'HEAD') { if (!is_file($path)) fail(404, 'No such blob'); exit; }
  $in = fopen('php://input', 'rb');
  $out = fopen("$path.tmp", 'wb');
  if (!$in || !$out) fail(500, 'Cannot store blob');
  stream_copy_to_stream($in, $out);
  fclose($out);
  rename("$path.tmp", $path);
  $type = preg_replace('/[^a-z0-9\/.+-]/i', '', $_SERVER['HTTP_X_BLOB_TYPE'] ?? 'application/octet-stream');
  file_put_contents("$path.type", $type);
  header('Content-Type: application/json');
  echo json_encode(['ok' => true, 'size' => filesize($path)]);
  exit;
}

fail(404, 'Unknown action');
