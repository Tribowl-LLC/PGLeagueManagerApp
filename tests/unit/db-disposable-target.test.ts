import { describe, expect, it, vi } from 'vitest';
import {
  DISPOSABLE_DATABASE_LABELS,
  DISPOSABLE_DATABASE_OWNER,
  disposableDatabaseMarker,
  encodeDisposableDatabaseLabel,
  readDisposableTargetProof,
  verifyOwnedLocalDisposableTarget,
  type DisposableContainerInspection,
  type DisposableDatabaseProbe,
  type DisposableTargetProof,
} from '../../scripts/lib/db-disposable-target';
import {
  pushDisposableDatabase,
  type PushDisposableRuntime,
} from '../../scripts/db-push-disposable';
import { REVIEWED_DRIZZLE_CONFIG_PATH } from '../../scripts/lib/drizzle-cli-environment';

const CONTAINER_ID = 'a'.repeat(64);
const TARGET_URL = 'postgresql://postgres:local-only@127.0.0.1:55432/inventory_push';
const proof: DisposableTargetProof = {
  containerId: CONTAINER_ID,
  runId: 'db-check-20260715-abcdef',
  purpose: 'db-check',
  database: 'inventory_push',
};

function validInspection(): DisposableContainerInspection {
  return {
    Id: CONTAINER_ID,
    State: { Running: true },
    Config: {
      Labels: {
        [DISPOSABLE_DATABASE_LABELS.owner]: DISPOSABLE_DATABASE_OWNER,
        [DISPOSABLE_DATABASE_LABELS.runId]: proof.runId,
        [DISPOSABLE_DATABASE_LABELS.purpose]: proof.purpose,
        [DISPOSABLE_DATABASE_LABELS.databases]: encodeDisposableDatabaseLabel([
          'inventory_push',
          'inventory_journal',
        ]),
      },
      Volumes: { '/var/lib/postgresql/data': {} },
    },
    HostConfig: {
      AutoRemove: true,
      Binds: null,
      Mounts: null,
      Tmpfs: null,
      VolumesFrom: null,
    },
    NetworkSettings: {
      Ports: {
        '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55432' }],
      },
    },
    Mounts: [{
      Type: 'volume',
      Name: 'b'.repeat(64),
      Destination: '/var/lib/postgresql/data',
      Driver: 'local',
      Mode: '',
      RW: true,
      Propagation: '',
    }],
  };
}

function validProbe(): DisposableDatabaseProbe {
  return {
    database: proof.database,
    role: 'postgres',
    marker: disposableDatabaseMarker(proof),
  };
}

function runtime(
  inspection: DisposableContainerInspection = validInspection(),
  database: DisposableDatabaseProbe = validProbe(),
): PushDisposableRuntime {
  return {
    inspectContainer: vi.fn(async () => inspection),
    probeDatabase: vi.fn(async () => database),
    spawnPush: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  };
}

describe('owned local disposable database proof', () => {
  it('parses a complete proof and requires a full lowercase container ID', () => {
    expect(readDisposableTargetProof({
      LV_DISPOSABLE_DB_CONTAINER_ID: CONTAINER_ID,
      LV_DISPOSABLE_DB_RUN_ID: proof.runId,
      LV_DISPOSABLE_DB_PURPOSE: proof.purpose,
      LV_DISPOSABLE_DB_DATABASE: proof.database,
    })).toEqual(proof);
    expect(() => readDisposableTargetProof({
      LV_DISPOSABLE_DB_CONTAINER_ID: 'a'.repeat(12),
      LV_DISPOSABLE_DB_RUN_ID: proof.runId,
      LV_DISPOSABLE_DB_PURPOSE: proof.purpose,
      LV_DISPOSABLE_DB_DATABASE: proof.database,
    })).toThrow('full lowercase Docker container ID');
  });

  it('accepts only an exact owned container, approved database, binding, role, and marker', async () => {
    const testRuntime = runtime();
    await expect(verifyOwnedLocalDisposableTarget(TARGET_URL, proof, testRuntime)).resolves.toMatchObject({
      targetUrl: TARGET_URL,
      database: 'inventory_push',
      role: 'postgres',
      containerId: CONTAINER_ID,
    });
    expect(testRuntime.inspectContainer).toHaveBeenCalledWith(CONTAINER_ID);
    expect(testRuntime.probeDatabase).toHaveBeenCalledWith(TARGET_URL);
  });

  it('refuses every remote target before Docker or PostgreSQL access', async () => {
    const testRuntime = runtime();
    await expect(verifyOwnedLocalDisposableTarget(
      'postgresql://postgres:secret@ep-production.neon.tech/inventory_push',
      proof,
      testRuntime,
    )).rejects.toThrow('Remote db:push is disabled');
    expect(testRuntime.inspectContainer).not.toHaveBeenCalled();
    expect(testRuntime.probeDatabase).not.toHaveBeenCalled();
  });

  it('refuses arbitrary loopback databases without independently verified container ownership', async () => {
    const testRuntime = runtime();
    testRuntime.inspectContainer = vi.fn(async () => { throw new Error('container not found'); });
    await expect(verifyOwnedLocalDisposableTarget(TARGET_URL, proof, testRuntime)).rejects.toThrow('container not found');
    expect(testRuntime.probeDatabase).not.toHaveBeenCalled();
  });

  it('refuses missing ownership labels and databases outside the exact approved list', async () => {
    const unowned = validInspection();
    delete unowned.Config?.Labels?.[DISPOSABLE_DATABASE_LABELS.owner];
    await expect(verifyOwnedLocalDisposableTarget(TARGET_URL, proof, runtime(unowned))).rejects.toThrow(
      'ownership label mismatch',
    );

    const wrongDatabase = validInspection();
    if (wrongDatabase.Config?.Labels) {
      wrongDatabase.Config.Labels[DISPOSABLE_DATABASE_LABELS.databases] =
        encodeDisposableDatabaseLabel(['inventory_journal']);
    }
    await expect(verifyOwnedLocalDisposableTarget(TARGET_URL, proof, runtime(wrongDatabase))).rejects.toThrow(
      'not present in the exact Docker approved-databases label',
    );
  });

  it('refuses stopped containers and non-loopback or mismatched port bindings', async () => {
    const stopped = validInspection();
    stopped.State = { Running: false };
    await expect(verifyOwnedLocalDisposableTarget(TARGET_URL, proof, runtime(stopped))).rejects.toThrow(
      'not running',
    );

    const publicBinding = validInspection();
    publicBinding.NetworkSettings = {
      Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '55432' }] },
    };
    await expect(verifyOwnedLocalDisposableTarget(TARGET_URL, proof, runtime(publicBinding))).rejects.toThrow(
      'exact 127.0.0.1 port binding',
    );
  });

  it('refuses containers that can preserve PostgreSQL data after removal', async () => {
    const retainedContainer = validInspection();
    if (retainedContainer.HostConfig) retainedContainer.HostConfig.AutoRemove = false;
    await expect(verifyOwnedLocalDisposableTarget(
      TARGET_URL,
      proof,
      runtime(retainedContainer),
    )).rejects.toThrow('must use auto-removal');

    const namedVolume = validInspection();
    if (namedVolume.HostConfig) {
      namedVolume.HostConfig.Binds = ['leaguevault_durable:/var/lib/postgresql/data'];
    }
    await expect(verifyOwnedLocalDisposableTarget(
      TARGET_URL,
      proof,
      runtime(namedVolume),
    )).rejects.toThrow('only its Docker-created anonymous PostgreSQL data volume');
  });

  it.each([
    [{ ...validProbe(), database: 'durable_local' }, 'Connected database or role'],
    [{ ...validProbe(), role: 'other_role' }, 'Connected database or role'],
    [{ ...validProbe(), marker: null }, 'exact LeagueVault disposable ownership marker'],
    [{ ...validProbe(), marker: `${disposableDatabaseMarker(proof)}-other` }, 'exact LeagueVault disposable ownership marker'],
  ] satisfies Array<[DisposableDatabaseProbe, string]>)('refuses mismatched database identity %#', async (database, message) => {
    await expect(verifyOwnedLocalDisposableTarget(TARGET_URL, proof, runtime(validInspection(), database))).rejects.toThrow(
      message,
    );
  });

  it('refuses URL query overrides even on an otherwise owned loopback target', async () => {
    const testRuntime = runtime();
    await expect(verifyOwnedLocalDisposableTarget(`${TARGET_URL}?host=other`, proof, testRuntime)).rejects.toThrow(
      'must not contain query overrides',
    );
    expect(testRuntime.inspectContainer).not.toHaveBeenCalled();
  });
});

describe('db:push:disposable execution binding', () => {
  it('uses the same explicit target URL for proof and child execution', async () => {
    const testRuntime = runtime();
    await pushDisposableDatabase({
      targetUrl: TARGET_URL,
      proof,
      args: ['--force'],
      environment: {
        DATABASE_URL: TARGET_URL,
        NODE_ENV: 'test',
        DEV_DB_OK: '1',
        DEV_DB_HOST_ALLOWLIST: 'anything',
        TEST_CONFIG_PATH_PREFIX: 'C:\\unreviewed-config',
        DOTENV_CONFIG_PATH: 'C:\\unreviewed.env',
        DOTENV_CONFIG_OVERRIDE: '1',
        DOTENV_KEY: 'unreviewed-key',
        NODE_OPTIONS: '--require C:\\unreviewed-preload.cjs',
        PGHOST: 'durable.example',
      },
    }, testRuntime);

    expect(testRuntime.probeDatabase).toHaveBeenCalledWith(TARGET_URL);
    expect(testRuntime.spawnPush).toHaveBeenCalledOnce();
    const [, args, environment] = vi.mocked(testRuntime.spawnPush).mock.calls[0];
    expect(args).toContain('push');
    expect(args).toContain('--force');
    expect(args).toContain(REVIEWED_DRIZZLE_CONFIG_PATH);
    expect(environment.DATABASE_URL).toBe(TARGET_URL);
    expect(environment.TEST_CONFIG_PATH_PREFIX).toBe('');
    expect(environment.DOTENV_CONFIG_OVERRIDE).toBe('');
    expect(environment.DOTENV_CONFIG_PATH).not.toBe('C:\\unreviewed.env');
    expect(environment.DOTENV_KEY).toBeUndefined();
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(environment.PGHOST).toBeUndefined();
  });

  it('refuses mismatched validated and executed URLs before proof or spawn', async () => {
    const testRuntime = runtime();
    await expect(pushDisposableDatabase({
      targetUrl: TARGET_URL,
      proof,
      environment: {
        DATABASE_URL: 'postgresql://postgres:local-only@127.0.0.1:55432/durable_local',
      },
    }, testRuntime)).rejects.toThrow('validated and executed DATABASE_URL values differ');
    expect(testRuntime.inspectContainer).not.toHaveBeenCalled();
    expect(testRuntime.spawnPush).not.toHaveBeenCalled();
  });

  it('refuses CLI target and config overrides before proof or spawn', async () => {
    const testRuntime = runtime();
    await expect(pushDisposableDatabase({
      targetUrl: TARGET_URL,
      proof,
      args: ['--force', '--url=postgresql://postgres:secret@remote.example/durable'],
      environment: { DATABASE_URL: TARGET_URL, NODE_ENV: 'test' },
    }, testRuntime)).rejects.toThrow('target or config overrides are refused');
    expect(testRuntime.inspectContainer).not.toHaveBeenCalled();
    expect(testRuntime.spawnPush).not.toHaveBeenCalled();
  });

  it('does not let DEV_DB_OK or hostname allowlists bypass remote refusal', async () => {
    const remote = 'postgresql://postgres:secret@ep-production.neon.tech/inventory_push';
    const testRuntime = runtime();
    await expect(pushDisposableDatabase({
      targetUrl: remote,
      proof,
      environment: {
        DATABASE_URL: remote,
        DEV_DB_OK: '1',
        DEV_DB_HOST_ALLOWLIST: 'ep-production',
      },
    }, testRuntime)).rejects.toThrow('Remote db:push is disabled');
    expect(testRuntime.spawnPush).not.toHaveBeenCalled();
  });
});
