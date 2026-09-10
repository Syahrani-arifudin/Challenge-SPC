<?php
use Ratchet\MessageComponentInterface;
use Ratchet\ConnectionInterface;

class RTserver implements MessageComponentInterface {

    protected $clients;
    protected $rooms = [];
    protected $meta = [];
    protected $locks = [];

    public function __construct() {
        $this->clients = new \SplObjectStorage();
    }

    public function onOpen($conn) {
        $this->clients->attach($conn);
        echo "Koneksi baru masuk!\n";
    }

    public function onMessage($from, $msg) {
       echo "Pesan diterima: $msg\n"; 
    
        $data = json_decode($msg, true);
        if (!is_array($data) || !isset($data['type'])) {
            return;
        }

        if ($data['type'] === 'join') {
            $this->handleJoin($from, $data);
        } elseif ($data['type'] === 'edit') {
            $this->handleEdit($from, $data);
        } elseif ($data['type'] === 'lock') {
            $this->handleLock($from, $data);
        }
    }

    protected function handleJoin($conn, $data) {
        $projectId = $data['projectId'] ?? null;
        $userId    = $data['userId'] ?? null;
        $userName  = $data['userName'] ?? 'Anonim';

        if (!$projectId || !$userId) {
            return;
        }

        if (!isset($this->rooms[$projectId])) {
            $this->rooms[$projectId] = new \SplObjectStorage();
        }
        $this->rooms[$projectId]->attach($conn);
        echo "Room '$projectId' sekarang isinya " . count($this->rooms[$projectId]) . " koneksi\n";

        $this->meta[$conn->resourceId] = [
            'projectId' => $projectId,
            'userId'    => $userId,
            'userName'  => $userName,
        ];

        $conn->send(json_encode([
            'type'  => 'locks',
            'locks' => $this->locks[$projectId] ?? new \stdClass(),
        ]));

        $this->broadcastPresence($projectId);
    }

    protected function handleEdit($from, $data) {
        $meta = $this->meta[$from->resourceId] ?? null;
        echo "EDIT masuk, resourceId pengirim: {$from->resourceId}\n";
        if (!$meta) {
            echo "DITOLAK: gak ketemu meta buat resourceId ini\n";
            return;
        }
        echo "EDIT dari project '{$meta['projectId']}', broadcast ke " . count($this->rooms[$meta['projectId']]) . " koneksi di room itu\n";
        if (!$meta) {
            return;
        }

        $payload = [
            'type'   => 'edit',
            'rowId'  => $data['rowId'] ?? null,
            'field'  => $data['field'] ?? null,
            'value'  => $data['value'] ?? null,
            'userId' => $meta['userId'],
        ];

        $this->broadcastToRoom($meta['projectId'], $payload, $from);
    }

    protected function handleLock($from, $data) {
        $meta = $this->meta[$from->resourceId] ?? null;
        if (!$meta) {
            return;
        }

        $projectId = $meta['projectId'];
        $key = ($data['rowId'] ?? '') . ':' . ($data['field'] ?? '');

        if (!isset($this->locks[$projectId])) {
            $this->locks[$projectId] = [];
        }

        if (!empty($data['isLocking'])) {
            $this->locks[$projectId][$key] = [
                'userId'   => $meta['userId'],
                'userName' => $meta['userName'],
            ];
        } else {
            if (
                isset($this->locks[$projectId][$key]) &&
                $this->locks[$projectId][$key]['userId'] === $meta['userId']
            ) {
                unset($this->locks[$projectId][$key]);
            }
        }

        $this->broadcastToRoom($projectId, [
            'type'  => 'locks',
            'locks' => $this->locks[$projectId],
        ]);
    }

    protected function broadcastPresence($projectId) {
        if (!isset($this->rooms[$projectId])) {
            return;
        }

        $users = [];
        foreach ($this->rooms[$projectId] as $conn) {
            if (isset($this->meta[$conn->resourceId])) {
                $m = $this->meta[$conn->resourceId];
                $users[$m['userId']] = $m['userName'];
            }
        }

        $this->broadcastToRoom($projectId, [
            'type'  => 'presence',
            'users' => $users,
        ]);
    }

    protected function broadcastToRoom($projectId, $payload, $exclude = null) {
        if (!isset($this->rooms[$projectId])) {
            return;
        }

        $message = json_encode($payload);

        foreach ($this->rooms[$projectId] as $conn) {
            if ($exclude !== null && $conn === $exclude) {
                continue;
            }
            $conn->send($message);
        }
    }

    public function onClose($conn) {
        $meta = $this->meta[$conn->resourceId] ?? null;

        if ($meta) {
            $projectId = $meta['projectId'];

            if (isset($this->locks[$projectId])) {
                foreach ($this->locks[$projectId] as $key => $lock) {
                    if ($lock['userId'] === $meta['userId']) {
                        unset($this->locks[$projectId][$key]);
                    }
                }
            }

            if (isset($this->rooms[$projectId])) {
                $this->rooms[$projectId]->detach($conn);
            }

            unset($this->meta[$conn->resourceId]);

            $this->broadcastPresence($projectId);
        }

        $this->clients->detach($conn);
        echo "Koneksi terputus!\n";
    }

    public function onError($conn, $e) {
        echo "Error: {$e->getMessage()}\n";
        $conn->close();
    }
}