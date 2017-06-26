import * as connect from 'connect';
import * as fs from 'graceful-fs';
import * as nfetch from 'node-fetch';
import * as http from 'http';
import * as semver from 'semver';
import * as temp from 'temp';
import * as os from 'os';
import * as download from 'download';
import { Observable } from 'rxjs';
import { } from 'electron';

export interface Credentials {
  username: string;
  password: string;
}

export interface UpdaterOptions {
  version: string;                                              // The version of the local app
  port: number;                                                 // The port to create the local HTTP server on
  updateUrl: string;                                            // The base URL or path to check updates on
  autoUpdater?: Electron.AutoUpdater                            // An optional implementation of Electron's autoUpdater
  bustUpdateCache?: boolean                                     // Should the cache be busted?
  logger?: (message: string, ...details: Array<any>) => void;   // Optional logger
}

export interface VersionJsonEntry {
  url: string;
  version: string;
  name?: string;
  notes?: string;
  pub_date?: string;
  supportedOS?: string;
}

/**
 * This class handles updates via Squirrel for Mac (aka the 'auto-updater'
 * module in Electron). It creates a fake update server for Squirrel to find,
 * so that we can just use S3 for updates.
 */
export class SquirrelUpdater {
  private version: string;
  private port: number;
  private updateUrl: string;
  private autoUpdater: Electron.AutoUpdater;
  private bustUpdateCache: boolean;
  private isAppStore: boolean = process.windowsStore! || process.mas || false;
  private logger: (message: string, ...details: Array<any>) => void;

  /**
   * Creates an instance of MacSquirrelUpdater
   *
   * @param  {MacSquirrelUpdaterOption} options
   * @param  {Object}   options.autoUpdater
   */
  constructor(options: UpdaterOptions) {
    if (this.isAppStore) return;

    this.version = options.version;
    this.port = options.port || 10203 + Math.floor(Math.random() * 100);
    this.updateUrl = options.updateUrl;
    this.autoUpdater = options.autoUpdater || require('electron').autoUpdater;
    this.bustUpdateCache = options.bustUpdateCache === false ? false : true;
    this.logger = options.logger || (() => {});

    this.logger(`MacUpdater: Created updater with URL ${this.updateUrl}`);

    if (process.platform !== 'darwin') throw new Error('electron-squirrel-s3 is for macOS only');
  }

  /**
   * Initiates and completes updates.
   *
   * @return {Promise<UpdateInformation | null>}  The available update, or null
   */
  public async checkForUpdates() {
    if (this.isAppStore) return null;

    let releases = `${this.updateUrl}/releases.json`;

    // Bust the cache on this update file one time, to get the latest
    if (this.bustUpdateCache) {
      this.bustUpdateCache = false;
      releases += `?v=${require('uuid/v4')()}`;
    }

    this.logger(`Checking for update.`, releases);

    // 1. Fetch the update file
    const versions: Array<VersionJsonEntry> = await nfetch(releases).then((res: any) => res.json());

    // The shape of versionJson is doc'd at http://is.gd/27TbWK, with an extra 'version'
    // field that we can use to find the latest version
    if (versions.length < 1) {
      this.logger('Remote version info has no entries?!');
      return null;
    }

    const newestRemoteUpdate = this.getNewestRemoteUpdate(versions);
    if (!(await this.isUpdateValid(newestRemoteUpdate))) return null;

    const jsonToServe = { url: `${this.updateServerUrl()}/download`, ...newestRemoteUpdate };

    // 3. Spin up a server which will serve up fake updates
    let updateServer;
    let result;

    try {
      updateServer = this.startUpdateServer(jsonToServe, newestRemoteUpdate.url);
      await updateServer.listening;

      const feedUrl = `${this.updateServerUrl()}/json`;
      this.logger('Starting up autoUpdater against the update server.');

      // 4. Call autoUpdater, wait for it to finish
      this.autoUpdater.setFeedURL(feedUrl);
      this.autoUpdater.checkForUpdates();

      result = await this.autoUpdaterFinished().toPromise();
      this.logger('AutoUpdater completed successfully.');
    } finally {
      if (updateServer) updateServer.shutdown();
    }

    return result;
  }

  public autoUpdaterFinished(): any {
    const autoUpdater = this.autoUpdater;
    const selector =  (_e: Error, releaseNotes: string, releaseName: string, releaseDate: Date) => ({ releaseNotes, releaseName, releaseDate });
    const notAvailable = Observable.fromEvent(autoUpdater, 'update-not-available').mapTo(null);
    const downloaded = Observable.fromEvent(autoUpdater, 'update-downloaded', selector);
    const error = Observable.fromEvent(autoUpdater, 'error').flatMap((e: Error) => { throw e });

    const ret = Observable.merge(notAvailable, downloaded, error)
      .take(1)
      .publishLast();

    ret.connect();
    return ret;
  }

  /**
   * Finds the latest update from a list of all available releases.
   *
   * @param {Object[]} versionJson     An array of objects parsed from a releases manifest file.
   *
   * @return {Object}
   */
  public getNewestRemoteUpdate(versionJson: Array<any>): VersionJsonEntry {
    return versionJson.reduce((acc, x) => {
      return (x && x.version && semver.gt(x.version, acc.version)) ? x : acc;
    });
  }

  /**
   * Checks to see if the updater should report that an update's available (and proceed with the
   * update)
   *
   * @param {Object} newestRemoteUpdate     The latest update available from
   *                                        {@link MacSquirrelUpdater#getNewestRemoteUpdate}
   * @return {Promise<Boolean>}
   */
  public isUpdateValid(newestRemoteUpdate: VersionJsonEntry): boolean {
    if (!newestRemoteUpdate) {
      this.logger('NewestRemoteUpdate is null.');
      return false;
    }

    if (newestRemoteUpdate.supportedOS) {
      const osVersion = os.release();

      // Don't try updating if we have the latest version, or if the latest update is unsupported on this version of macOS
      try {
        if (!semver.satisfies(osVersion, newestRemoteUpdate.supportedOS)) {
          this.logger(`New version available, but it's not supported on this version of macOS.`);
          return false;
        }
      } catch (e) {
        this.logger(`Something went wrong when checking the user's current OS against the supported OS version range.`, e);
        return false;
      }
    }

    // Check the version
    if (!semver.gt(newestRemoteUpdate.version, this.version)) return false;

    return true;
  }

  /**
   * Returns the update server URL
   *
   * @return {String}   The update server URL
   */
  public updateServerUrl() {
    return `http://localhost:${this.port}`;
  }

  /**
   * Starts an update server that serves out the content that Squirrel expects.
   * Right now this consists of a '/json' endpoint which Squirrel checks to get
   * the download URL to use, and a '/download' endpoint which will serve out
   * the actual data (by proxying it from another source, like a URL or file).
   *
   * @param  {Object} jsonToServe       The JSON to serve on the /json endpoint
   * @param  {String} fileOrUrlToServe  The URL or File to serve on the /download
   *                                    endpoint
   *
   * @return {Object}
   * @return {Object}.listening         A Promise that starts the server, and
   *                                    resolves when the server is listening
   * @return {Object}.shutdown          A method that will shutdown the server
   */
  public startUpdateServer(jsonToServe: any, fileOrUrlToServe: string) {
    let server: any;

    const listening = new Promise((resolve, reject) => {
      try {
        const app = connect();
        app.use('/download', async (_: http.IncomingMessage, res: http.ServerResponse) => {
          this.logger(`Serving up download: ${fileOrUrlToServe}.`);

          const { path } = temp.openSync('update');
          try {
            await download(fileOrUrlToServe, path);
            fs.createReadStream(path).pipe(res);
          } catch (e) {
            res.writeHead(500, e.message);
            res.end();
          }
        });

        app.use('/json', (_: http.IncomingMessage, res: http.ServerResponse) => {
          this.logger(`Serving up JSON:`, jsonToServe);
          res.end(JSON.stringify(jsonToServe));
        });

        this.logger(`Starting fake update server on port ${this.port}.`);

        server = http.createServer(app);
        server.listen(this.port, '127.0.0.1');
        server.once('listening', () => resolve(true));
      } catch (e) {
        this.logger(`Couldn't start update server.`, e);
        reject(e);
      }
    });

    const shutdown = () => {
      this.logger(`Shutting down fake update server on port ${this.port}.`);
      if (server) server.close();
    };

    return { listening, shutdown };
  }
}
