<?php
require __DIR__ . '/vendor/autoload.php';
require __DIR__ . '/src/RTserver.php';

use Ratchet\Server\IoServer;
use Ratchet\Http\HttpServer;
use Ratchet\WebSocket\WsServer;

$server = IoServer::factory(
    new HttpServer(
        new WsServer(
            new RTserver()
        )
    ),
    8080
);

echo "Server jalan di ws://localhost:8080\n";
$server->run();