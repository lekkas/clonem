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
  var Configstore = require('configstore');

  var pkg = require('./package.json');

  var token_url = 'https://github.com/settings/tokens';
  var baseAPIUrl = 'https://api.github.com';

  // TODO: Use more decent CLI parsing
  cmd
    .version(pkg.version)
    .usage('[options] [user|organization]')
    .option('-u, --update', 'Update (git pull) cloned repositories of user/organization')
    .option('--no-fork', 'Ignore forked repositories')
    .option('-v, --verbose', 'Print git messages')
    .option('-t, --token <token>', 'Save Github personal API token')
    .parse(process.argv);

  if ( !cmd.token && (!cmd.args || cmd.args.length !== 1) ) {
    cmd.outputHelp();
    process.exit(1);
  }

  var conf = new Configstore(pkg.name, {token: ''});
  if (cmd.token) {
    conf.set('token', cmd.token);
    console.log(chalk.green.bold('* Saved token'));
    if (!cmd.args || cmd.args.length !== 1)
      process.exit(0);
  }

  var options = {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'lekkas/repo-fetch'
    }
  };

  if (!conf.get('token')) {
    console.log(chalk.yellow.bold('* No personal API token found. Your requests may get rate limited'));
    console.log(chalk.yellow.bold('* Create a token at <' + token_url + '> and save it using the -t option\n'));
  } else {
    options.headers['Authorization'] = 'token ' + conf.get('token');
  }

  var baseRequest = request.defaults(options);
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
        console.log(chalk.red.bold('Status Code: '+ resp.statusCode));
        console.log(chalk.red.bold(body));
        process.exit(3);
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
        console.log(chalk.red.bold('Status Code: '+ resp.statusCode));
        console.log(chalk.red.bold(body));
        process.exit(3);
      }

      body = JSON.parse(body);
      var currentPageRepos = body
          .filter(function(repo) {
            return cmd.fork || (!cmd.fork && !repo.fork);
          })
          .map(function(repo) {
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

  // Populate 'repoPageList' with list of repository pages
  async.waterfall([

      /*
       * Waterfall 1: Get URLs of all repository pages
       */
      function(callback) {
        var repoPageList = [];
        var repoPage = baseAPIUrl + '/users/' + cmd.args[0] + '/repos';
        repoPageList.push(repoPage);
        console.log(chalk.yellow('* Fetching repository pages'));
        getNextRepoPage(repoPage, repoPageList, callback);
      },

      /*
       * Waterfall 2: Get repository clone URLs
       */
      function(repoPageList, callback) {
        var repoList = [];

        // TODO: Is nesting 'async' module calls considered an antipattern?
        process.stdout.write(chalk.yellow('* Fetching clone URLs'));
        async.each(repoPageList, function (repoPage, cb) {
            getRepos(repoPage, repoList, cb);
          },
          function (err) {
            if (err) {
              console.log(chalk.red.bold('Error: '+err));
              process.exit(2);
            }
            process.stdout.write(chalk.green(' - found ' + repoList.length
                  + ' repositories\n'));
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
        } else {
          console.log(chalk.blue.bold('* Done!'));
        }
  });
}).call(this);
