import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as utils from './utils';

/**
 * Encapsulates some information about the release.
 */
export interface GoRelease {

  /**
   * The tags the release created.
   */
  readonly tags?: string[];
}

export class GoReleaser {

  private readonly version?: string;

  private readonly dir: string;
  private readonly dryRun: boolean;
  private readonly gitBranch: string;
  private readonly gitUsername: string;
  private readonly gitUseremail: string;

  private readonly _cloner: (repository: string, targetDir: string) => void;

  constructor(dir?: string) {

    try {
      utils.which('git');
    } catch (err) {
      throw new Error('git must be available to create this release');
    }

    this.version = process.env.VERSION;
    this.dir = dir ?? 'dist/go';
    this.gitBranch = process.env.GIT_BRANCH ?? 'main';
    this._cloner = this.cloneGitHub;
    this.dryRun = (process.env.DRY_RUN ?? 'false').toLowerCase() === 'true';
    this.gitUsername = process.env.GIT_USER_NAME ?? utils.shell('git config user.name');
    this.gitUseremail = process.env.GIT_USER_EMAIL ?? utils.shell('git config user.email');

    if (this.gitUseremail === '') {
      throw new Error('Unable to detect username. either configure a global git user.name or pass GIT_USER_NAME env variable');
    }

    if (this.gitUsername === '') {
      throw new Error('Unable to detect user email. either configure a global git user.email or pass GIT_USER_EMAIL env variable');
    }
  }

  /**
   * Run the release process.
   *
   * @returns metadata about the release.
   */
  public release(): GoRelease {

    const modules = this.collectModules(this.dir);
    console.log('Detected modules:');
    modules.forEach(m => console.log(` - ${m}`));

    const repo = this.extractRepo(modules);
    const repoDir = path.join(fs.mkdtempSync(os.tmpdir()), path.basename(repo));
    this._cloner(repo, repoDir);

    process.chdir(repoDir);

    try {
      utils.shell(`git checkout ${this.gitBranch}`);
    } catch (err) {
      utils.shell(`git checkout -b ${this.gitBranch}`);
    }

    this.syncModules(repoDir);

    try {
      utils.shell('git add .');
      utils.shell('git diff-index --exit-code HEAD --');
      console.log('No changes. Skipping release');
      return {};
    } catch (err) {
      // changes exist, thats ok.
    }

    utils.shell(`git config user.name ${this.gitUsername}`);
    utils.shell(`git config user.email ${this.gitUseremail}`);

    const commitMessage = process.env.GIT_COMMIT_MESSAGE ?? this.createReleaseMessage(modules);

    utils.shell(`git commit -m "${commitMessage}"`);

    const tags = modules.map(m => this.createTag(m, repoDir));

    if (this.dryRun) {
      console.log(`Will push to branch: ${this.gitBranch}`);
      tags.forEach(t => console.log(`Will push tag: ${t}`));
    } else {
      utils.shell(`git push origin ${this.gitBranch}`);
      tags.forEach(t => utils.shell(`git push origin ${t}`));
    }
    return { tags };
  }

  private cloneGitHub(repository: string, targetDir: string) {

    const gitHubToken = process.env.GITHUB_TOKEN;

    if (!gitHubToken) {
      throw new Error('GITHUB_TOKEN env variable is required');
    }

    utils.shell(`git clone https://${gitHubToken}@github.com/${repository}.git ${targetDir}`);
  }

  private collectModules(dir: string): string[] {

    const modules = [];

    // top level module
    if (fs.existsSync(path.join(dir, 'go.mod'))) {
      modules.push(dir);
    }

    // submodules
    for (const p of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, p);
      if (fs.existsSync(path.join(fullPath, 'go.mod'))) {
        modules.push(fullPath);
      }
    }

    return modules;
  }

  private syncModules(repoDir: string) {
    const topLevel = path.join(repoDir, 'go.mod');
    if (fs.existsSync(topLevel)) {
      // with top level modules we sync the entire repository
      utils.removeDirectory(repoDir, { includeRoot: false, exclude: ['.git'] });
    } else {
      // otherwise, we selectively remove the submodules only.
      for (const p of fs.readdirSync(repoDir)) {
        const submodule = path.join(repoDir, p, 'go.mod');
        if (fs.existsSync(submodule)) {
          utils.removeDirectory(path.join(repoDir, p));
        }
      }
    }
    utils.shell(`cp -r ${this.dir}/* ${repoDir}`, { shell: true });
  }

  private extractRepo(modules: string[]): string {
    const repos = new Set<string>();

    function findModuleDeclaration(_modFile: string) {
      for (const line of fs.readFileSync(_modFile).toString().split('\n')) {
        if (line.startsWith('module ')) {
          return line.split(' ')[1];
        }
      }
      throw new Error(`No module declaration in file: ${_modFile}`);
    }

    for (const module of modules) {
      const modFile = path.join(module, 'go.mod');
      const fullModuleName = findModuleDeclaration(modFile).split('/');
      const owner = fullModuleName[1];
      const repo = fullModuleName[2];
      repos.add(`${owner}/${repo}`);
    }

    if (repos.size === 0) {
      throw new Error('Unable to detect repository from module files.');
    }
    if (repos.size > 1) {
      throw new Error('Multiple repositories found in module files');
    }
    return repos.values().next().value;
  }

  private createReleaseMessage(modules: readonly string[]) {
    let message = 'chore(release):';
    if (this.version) {
      return `${message} ${this.version}`;
    }
    for (const module of modules) {
      const moduleName = path.basename(module);
      const moduleVersion = this.extractVersion(module);
      message = `${message} ${moduleName}@${moduleVersion}`;
    }
    return message;
  }

  private createTag(moduleDirectory: string, repoDir: string): string {
    const moduleName = path.basename(moduleDirectory);
    const moduleVersion = this.extractVersion(moduleDirectory);
    let tagName = undefined;
    if (moduleName === path.basename(repoDir)) {
      // root module
      tagName = `v${moduleVersion}`;
    } else {
      // sub module
      tagName = `${moduleName}/v${moduleVersion}`;
    }
    utils.shell(`git tag -a ${tagName} -m ${tagName}`);
    return tagName;
  }

  private extractVersion(moduleDirectory: string) {
    let moduleVersion = undefined;
    const versionFile = path.join(moduleDirectory, 'version');
    if (this.version) {
      moduleVersion = this.version;
    } else if (fs.existsSync(versionFile)) {
      moduleVersion = fs.readFileSync(versionFile);
    } else {
      throw new Error(`Unable to determine version of module ${moduleDirectory}. `
        + 'Either include a \'version\' file, or specify a global version using the VERSION environment variable.');
    }
    return moduleVersion;
  }

}