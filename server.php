<?php
// require memuat dependency Composer dan class aplikasi.
require __DIR__ . '/vendor/autoload.php';
require __DIR__ . '/src/Database.php';
require __DIR__ . '/src/RTserver.php';

use Ratchet\Server\IoServer;
use Ratchet\Http\HttpServer;
use Ratchet\WebSocket\WsServer;

// IoServer menjalankan event loop untuk menerima koneksi realtime.
$server = IoServer::factory(
    new HttpServer(
        new WsServer(
            new RTserver(new Database(__DIR__ . '/data/rab.sqlite'))
        )
    ),
    8080
);

// run() membuat proses server tetap berjalan dan menunggu client.
echo "Server jalan di ws://localhost:8080\n";
$server->run();