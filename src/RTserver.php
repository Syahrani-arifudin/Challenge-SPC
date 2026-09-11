<?php
use Ratchet\MessageComponentInterface;
use Ratchet\ConnectionInterface;

/**
 * Server realtime untuk Estimator RAB.
 *
 * State realtime seperti locks dan presence tetap disimpan di memory,
 * sedangkan data tabel dan nama project dipersistenkan melalui Database.
 */
class RTserver implements MessageComponentInterface {

    protected $clients;
    protected $rooms = [];   // projectId => SplObjectStorage berisi koneksi
    protected $meta  = [];   // resourceId => ['projectId'=>, 'userId'=>]
    protected $state = [];   // projectId => ['data'=>[], 'locks'=>[], 'presence'=>[], 'projectName'=>'Proyek Baru']
    protected $database;

    public function __construct(Database $database) {
        $this->clients = new \SplObjectStorage();
        $this->database = $database;
    }

    public function onOpen($conn) {
        $this->clients->attach($conn);
    }

    public function onMessage($from, $msg) {
        $data = json_decode($msg, true);
        if (!is_array($data) || !isset($data['type'])) {
            return;
        }

        switch ($data['type']) {
            case 'join':
                $this->handleJoin($from, $data);
                break;
            case 'data':
                $this->handleData($from, $data);
                break;
            case 'locks':
                $this->handleLocks($from, $data);
                break;
            case 'editorStart':
                $this->broadcastToRoom($this->meta[$from->resourceId]['projectId'] ?? null, [
                    'type'   => 'editorStart',
                    'editor' => $data['editor'] ?? null,
                ], $from);
                break;
            case 'editorStop':
                $this->broadcastToRoom($this->meta[$from->resourceId]['projectId'] ?? null, [
                    'type'   => 'editorStop',
                    'key'    => $data['key'] ?? null,
                    'userId' => $this->meta[$from->resourceId]['userId'] ?? null,
                ], $from);
                break;
            case 'presence':
                $this->handlePresence($from, $data);
                break;
            case 'projectName':
                $this->handleProjectName($from, $data);
                break;
            case 'action':
                $this->handleAction($from, $data);
                break;
        }
    }

    protected function ensureState($projectId) {
        if (!isset($this->state[$projectId])) {
            $stored = $this->database->loadProject($projectId);
            $this->state[$projectId] = [
                'data'        => $stored['data'],
                'locks'       => new \stdClass(),
                'presence'    => new \stdClass(),
                'projectName' => $stored['projectName'],
            ];
        }
    }

    protected function handleJoin($conn, $data) {
        $projectId = $data['projectId'] ?? null;
        $userId    = $data['userId'] ?? null;

        if (!$projectId || !$userId) {
            return;
        }

        if (!isset($this->rooms[$projectId])) {
            $this->rooms[$projectId] = new \SplObjectStorage();
        }
        $this->rooms[$projectId]->attach($conn);
        $this->meta[$conn->resourceId] = [
            'projectId' => $projectId,
            'userId'    => $userId,
        ];

        $this->ensureState($projectId);

        // kirim state lengkap yang sudah ada ke user yang baru join
        // (ini gantinya onValue() Firebase yang otomatis kasih data awal)
        $conn->send(json_encode([
            'type'        => 'state',
            'data'        => $this->state[$projectId]['data'],
            'locks'       => $this->state[$projectId]['locks'],
            'presence'    => $this->state[$projectId]['presence'],
            'projectName' => $this->state[$projectId]['projectName'],
        ]));
    }

    protected function handleData($from, $data) {
        $meta = $this->meta[$from->resourceId] ?? null;
        if (!$meta) return;
        $projectId = $meta['projectId'];
        $this->ensureState($projectId);

        $this->state[$projectId]['data'] = $data['payload'] ?? [];
        $this->database->saveProject(
            $projectId,
            $this->state[$projectId]['data'],
            $this->state[$projectId]['projectName']
        );

        $this->broadcastToRoom($projectId, [
            'type'    => 'data',
            'payload' => $this->state[$projectId]['data'],
            'editor'  => $data['editor'] ?? null,
        ], $from);
    }

    protected function handleLocks($from, $data) {
        $meta = $this->meta[$from->resourceId] ?? null;
        if (!$meta) return;
        $projectId = $meta['projectId'];
        $this->ensureState($projectId);

        $this->state[$projectId]['locks'] = $data['payload'] ?? new \stdClass();

        $this->broadcastToRoom($projectId, [
            'type'    => 'locks',
            'payload' => $this->state[$projectId]['locks'],
        ], $from);
    }

    protected function handlePresence($from, $data) {
        $meta = $this->meta[$from->resourceId] ?? null;
        if (!$meta) return;
        $projectId = $meta['projectId'];
        $this->ensureState($projectId);

        $userId = $data['userId'] ?? $meta['userId'];
        $entry  = $data['entry'] ?? null;
        if (!$entry) return;

        // presence disimpan sebagai objek asosiatif, jadi kita convert
        // dulu dari stdClass (hasil decode sebelumnya) ke array supaya
        // gampang di-set per-key
        $presence = (array) $this->state[$projectId]['presence'];
        $presence[$userId] = $entry;
        $this->state[$projectId]['presence'] = $presence;

        $this->broadcastToRoom($projectId, [
            'type'    => 'presence',
            'payload' => $presence,
        ]); // dikirim ke semua termasuk pengirim, biar konsisten kayak Firebase onValue
    }

    protected function handleProjectName($from, $data) {
        $meta = $this->meta[$from->resourceId] ?? null;
        if (!$meta) return;
        $projectId = $meta['projectId'];
        $this->ensureState($projectId);

        $this->state[$projectId]['projectName'] = $data['payload'] ?? 'Proyek Baru';
        $this->database->saveProjectName(
            $projectId,
            $this->state[$projectId]['projectName'],
            $this->state[$projectId]['data']
        );

        $this->broadcastToRoom($projectId, [
            'type'    => 'projectName',
            'payload' => $this->state[$projectId]['projectName'],
        ], $from);
    }

    protected function handleAction($from, $data) {
        $meta = $this->meta[$from->resourceId] ?? null;
        if (!$meta) return;

        $this->broadcastToRoom($meta['projectId'], [
            'type' => 'action',
            'text' => $data['text'] ?? '',
        ], $from); // exclude pengirim, dia sudah lihat toast-nya sendiri lebih dulu
    }

    protected function broadcastToRoom($projectId, $payload, $exclude = null) {
        if (!isset($this->rooms[$projectId])) return;
        $message = json_encode($payload);

        foreach ($this->rooms[$projectId] as $conn) {
            if ($exclude !== null && $conn === $exclude) continue;
            $conn->send($message);
        }
    }

    public function onClose($conn) {
        $meta = $this->meta[$conn->resourceId] ?? null;

        if ($meta) {
            $projectId = $meta['projectId'];
            $userId    = $meta['userId'];

            if (isset($this->state[$projectId])) {
                // lepas semua lock milik user ini
                $locks = (array) $this->state[$projectId]['locks'];
                foreach ($locks as $key => $lock) {
                    if (($lock['userId'] ?? null) === $userId) {
                        unset($locks[$key]);
                    }
                }
                $this->state[$projectId]['locks'] = $locks;

                // hapus dari presence
                $presence = (array) $this->state[$projectId]['presence'];
                unset($presence[$userId]);
                $this->state[$projectId]['presence'] = $presence;

                if (isset($this->rooms[$projectId])) {
                    $this->rooms[$projectId]->detach($conn);
                }

                $this->broadcastToRoom($projectId, ['type' => 'locks', 'payload' => $locks]);
                $this->broadcastToRoom($projectId, ['type' => 'presence', 'payload' => $presence]);
            }

            unset($this->meta[$conn->resourceId]);
        }

        $this->clients->detach($conn);
    }

    public function onError($conn, $e) {
        echo "Error: {$e->getMessage()}\n";
        $conn->close();
    }
}