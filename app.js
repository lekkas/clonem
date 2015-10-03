(function () {

  var spawn = require('child_process').spawn;
  var path = require('path');
  var fs = require('fs');

  var parse = require('parse-link-header');
  var cmd = require('commander');
  var request = require('request');
  var async = require('async');
  var chalk = require('chalk');
  var _ = require('lodash');

  var config = require('./config');
  var ver = require('./package.json').version;


  cmd
    .version(ver)
    .usage('[options] <user|organization>')
    .option('-u, --update', 'Update (git pull) cloned repositories')
    .option('--forked', 'Only clone forked repositories - TODO')
    .option('--own', 'Only clone own repositories - TODO')
    .option('-v, --verbose', 'Print git tool messages')
    .parse(process.argv);

  if (!cmd.args || cmd.args.length !== 1) {
    cmd.outputHelp();
    process.exit(1);
  }

  var activeChild;

  /*
   * Signal handler for Ctrl-C (SIGINT)
   * Aborts current operation (clone or update) on github repository
   */
  process.on('SIGINT', function() {
    if (activeChild) {
      process.stdout.write(chalk.red(' - Aborting operation\n'));
      activeChild.kill('SIGKILL');
      activeChild = null;
    }
  });

  /*
   * Get next repository page. When github repositories of a user/org
   * are more than a certain threshold, Github paginates the repository
   * list.
   *
   * @param repoPageURL The URL of a repository page. Normally this will be the
   * first one, i.e. https://api.github.com/users/:user/repos . The function
   * will then recursively append all next repository pages, if they exist, to
   * the repoPages list.
   * @param repoPages A list containing all repository page URL's
   * @callback Callback to call when all repository pages have been retrieved
   */
  function getNextRepoPage(repoPageURL, repoPages, callback) {
    baseRequest.get(repoPageURL, function(error, resp, body) {
      if (error || resp.statusCode != 200) {
        return callback(error);
      }

      if (!resp.headers.link)
        return callback(null, repoPages);

      var parsed = parse(resp.headers.link);
      if (parsed.next && parsed.next.url) {
        var nextRepoPageURL = parsed.next.url;
        repoPages.push(nextRepoPageURL);

        /*
         * Prevent the stack from overflowing while we are recursing,
         * though this is unlikely to happen, since we don't expect
         * a large number of github repository pagination
         * results. Just playing with node here.
         */
        async.nextTick(function() {
          getNextRepoPage(nextRepoPageURL, repoPages, callback);
        });
      } else {
          callback(null, repoPages);
      }
    });
  }

  /*
   * Get full name, clone url and size of repository.
   *
   * @param repoPageURL The URL of repository page
   * @param repos List of repository info objects:
   * {
   *  full_name: 'user/repo',
   *  clone_url: 'URL',
   *  size: 0
   * }
   * @param callback Callback to signal that repository info objects of for
   * current page
   * have been added to the list
   */
  function getRepos(repoPageURL, repos, callback) {
    baseRequest.get(repoPageURL, function(error, resp, body) {
      if (error || resp.statusCode != 200) {
        return callback(error);
      }

      body = JSON.parse(body);
      var currentPageRepos = body.map(function(repo) {
        return {
          full_name: repo.full_name,
          clone_url: repo.clone_url,
          size: repo.size
        };
      });

      currentPageRepos.forEach(function(repo) {
        repos.push(repo);
      });

      callback();
    });
  }

  /*
   * Clone git repository, given a clone url.
   *
   * @param repoInfo The repository info object
   * {
   *  full_name: 'user/repo',
   *  clone_url: 'URL',
   *  size: 0
   * }
   *
   * cloneRepo() will clone repo at location 'clone_url' into folder 'full_name'
   */
  function cloneRepo(repoInfo) {
    return function(callback) {
      var opts = {
        stdio: [
          'pipe', // pipe child's stdin to parent
          cmd.verbose ? 1 : 'ignore', // use parent's stdout
          cmd.verbose ? 2 : 'ignore'  // use parent's stderr
        ]
      };

      var args = [
        'clone',
        repoInfo.clone_url,
        repoInfo.full_name
      ];

      process.stdout.write(chalk.yellow.bold(' * Cloning '+repoInfo.full_name));
      var child = spawn('git', args, opts);
      child.full_name = repoInfo.full_name;
      activeChild = child;

      child.on('close', function(code, signal) {
        if (code) {
          process.stdout.write(chalk.red.bold(' - git clone failed\n'));
        } else if (!signal) {
          process.stdout.write(chalk.green.bold(' - OK\n'));
        }
        callback(null);
      });
      child.on('error', function(err) {
        if (err) {
          console.log(chalk.red.bold(' - ' + err.message));
        }
      });
    };
  }

  /*
   * Update git repository
   *
   * @param repoInfo The repository info object
   * {
   *  full_name: 'user/repo',
   *  clone_url: 'URL',
   *  size: 0
   * }
   */
  function updateRepo(repoInfo) {
    return function(callback) {

      var dir = path.join(process.cwd(), repoInfo.full_name);
      var opts = {
        cwd: dir,
        stdio: [
          'pipe', // pipe child's stdin to parent
          cmd.verbose ? 1 : 'ignore', // use parent's stdout
          cmd.verbose ? 2 : 'ignore'  // use parent's stderr
        ]
      };

      var args = [
        'pull'
      ];

      process.stdout.write(chalk.yellow.bold(' * Updating '+repoInfo.full_name));
      var child = spawn('git', args, opts);
      child.full_name = repoInfo.full_name;
      activeChild = child;

      child.on('close', function(code, signal) {
        if (code) {
          process.stdout.write(chalk.red.bold(' - git pull failed\n'));
        } else if (!signal) {
          process.stdout.write(chalk.green.bold(' - OK\n'));
        }
        callback(null);
      });

      child.on('error', function(err) {
        if (err) {
          console.log(chalk.red.bold(' - ' + err.message));
        }
        callback(null);
      });
    };
  }
  var baseUrl = 'https://api.github.com';
  var baseRequest = request.defaults({
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'lekkas/repo-fetch',
      'Authorization': 'token ' + config.token
    }
  });

  // Populate 'repoPageList' with list of repository pages
  async.waterfall([

      /*
       * Waterfall 1: Get URLs of all repository pages
       */
      function(callback) {
        var repoPageList = [];
        var repoPage = baseUrl + '/users/' + cmd.args[0] + '/repos';
        repoPageList.push(repoPage);
        console.log(chalk.green('* Fetching repository pages'));
        getNextRepoPage(repoPage, repoPageList, callback);
      },

      /*
       * Waterfall 2: Get repository clone URLs
       */
      function(repoPageList, callback) {
        var repoList = [];

        // TODO: Is nesting 'async' module calls considered an antipattern?
        console.log(chalk.green('* Fetching repository urls'));
        async.each(repoPageList, function (repoPage, cb) {
            getRepos(repoPage, repoList, cb);
          },
          function (err) {
            if (err) {
              console.log(chalk.red.bold('Error: '+err));
              process.exit(2);
            }
            callback(null, repoList);
        });
      },

      /*
       * Waterfall 3: Create task queue
       */
      function(repoList, callback) {
        var cloneTasks = [];
        var updateTasks = [];
        var cloneList = [];
        var taskQueue = [];

        if (repoList.length === 0) {
          return callback(new Error(chalk.yellow.bold('* No repositories found')));
        }

        async.each(repoList, function(repo, cb) {
          var dir = path.join(process.cwd(), repo.full_name);
            fs.readdir(dir, function(err, files) {

              // Directory does not exist
              if (err) {
                taskQueue.push(cloneRepo(repo));
              } else {

                /*
                 * If directory is empty then enqueue a clone task
                 * for the respective repository
                 */
                if (files.length === 0) {
                  taskQueue.push(cloneRepo(repo));
                } else {

                  // Directory is not empty, so enqueue update task
                  if (cmd.update) {
                    taskQueue.push(updateRepo(repo));
                  }
                }
              }
              cb(null);
            });
        },
        function(err) {
          callback(null, taskQueue);
        });
      },

      /*
       * Waterfall 4: Run clone & update tasks
       */
      function(taskQueue, callback) {
        async.series(taskQueue, function(err) {
          if (err) {
            console.log(err.message);
          }
          callback(null);
        });
      },
    ], function (err) {
        if (err) {
          console.log(err.message);
        }
        console.log(chalk.blue.bold('* Done!'));
  });
}).call(this);
