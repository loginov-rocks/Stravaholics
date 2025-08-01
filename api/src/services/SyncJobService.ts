import { Queue } from 'bullmq';

import { SyncJobCompletedResult, SyncJobParams } from '../models/syncJobModel';
import { SyncJobRepository } from '../repositories/SyncJobRepository';

interface Options {
  syncJobQueue: Queue;
  syncJobRepository: SyncJobRepository;
}

export class SyncJobService {
  private readonly syncJobQueue: Queue;
  private readonly syncJobRepository: SyncJobRepository;

  constructor({ syncJobQueue, syncJobRepository }: Options) {
    this.syncJobQueue = syncJobQueue;
    this.syncJobRepository = syncJobRepository;
  }

  public async createSyncJob(userId: string, params?: SyncJobParams) {
    const syncJob = await this.syncJobRepository.create({
      userId,
      status: 'created',
      params,
    });

    await this.syncJobQueue.add('syncJob', { syncJobId: syncJob.id, userId, params });

    return syncJob;
  }

  public getSyncJob(syncJobId: string) {
    return this.syncJobRepository.findById(syncJobId);
  }

  public getSyncJobsByUserId(userId: string) {
    return this.syncJobRepository.findByUserId(userId);
  }

  public markSyncJobStarted(syncJobId: string) {
    return this.syncJobRepository.updateById(syncJobId, {
      status: 'started',
      startedAt: new Date(),
    });
  }

  public markSyncJobCompleted(syncJobId: string, result: SyncJobCompletedResult) {
    return this.syncJobRepository.updateById(syncJobId, {
      status: 'completed',
      completedAt: new Date(),
      completedResult: result,
    });
  }

  public markSyncJobFailed(syncJobId: string, error: Error) {
    return this.syncJobRepository.updateById(syncJobId, {
      status: 'failed',
      failedAt: new Date(),
      failedError: {
        message: error.message,
        stack: error.stack,
      },
    });
  }
}
