<?php

class Database
{
    // PDO menyimpan koneksi database yang dipakai seluruh method class.
    private \PDO $pdo;

    public function __construct(string $databasePath)
    {
        // Constructor otomatis berjalan saat object Database dibuat.
        $directory = dirname($databasePath);
        if (!is_dir($directory) && !mkdir($directory, 0775, true) && !is_dir($directory)) {
            throw new \RuntimeException("Tidak dapat membuat direktori database: {$directory}");
        }

        // PDO membuka koneksi ke file SQLite.
        $this->pdo = new \PDO('sqlite:' . $databasePath);
        $this->pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec(
            'CREATE TABLE IF NOT EXISTS projects (' .
            'project_id TEXT PRIMARY KEY, ' .
            'project_name TEXT NOT NULL DEFAULT \'Proyek Baru\', ' .
            'data_json TEXT NOT NULL DEFAULT \'[]\', ' .
            'updated_at TEXT NOT NULL' .
            ')'
        );
    }

    public function loadProject(string $projectId): array
    {
        // prepare() membuat query berparameter agar input tidak ditempel langsung ke SQL.
        $statement = $this->pdo->prepare(
            'SELECT project_name, data_json FROM projects WHERE project_id = :project_id'
        );
        $statement->execute(['project_id' => $projectId]);
        $project = $statement->fetch(\PDO::FETCH_ASSOC);

        if (!$project) {
            return [
                'data' => [],
                'projectName' => 'Proyek Baru',
            ];
        }

        // json_decode mengubah JSON yang tersimpan menjadi array PHP.
        $data = json_decode($project['data_json'], true);
        return [
            'data' => is_array($data) ? $data : [],
            'projectName' => $project['project_name'] ?: 'Proyek Baru',
        ];
    }

    public function saveProject(string $projectId, array $data, string $projectName): void
    {
        // Method ini menyimpan seluruh snapshot project ke SQLite.
        $statement = $this->pdo->prepare(
            'INSERT INTO projects (project_id, project_name, data_json, updated_at) ' .
            'VALUES (:project_id, :project_name, :data_json, :updated_at) ' .
            'ON CONFLICT(project_id) DO UPDATE SET ' .
            'project_name = excluded.project_name, ' .
            'data_json = excluded.data_json, ' .
            'updated_at = excluded.updated_at'
        );
        $statement->execute([
            'project_id' => $projectId,
            'project_name' => $projectName ?: 'Proyek Baru',
            // json_encode mengubah array PHP menjadi JSON untuk disimpan.
            'data_json' => json_encode($data, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
            'updated_at' => gmdate('c'),
        ]);
    }

    public function saveProjectName(string $projectId, string $projectName, array $data): void
    {
        $this->saveProject($projectId, $data, $projectName);
    }
}
