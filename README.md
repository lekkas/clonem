# clonem


Clone (or update) all repositories belonging to user or organization.

**Still Under Development**

## Features

* Automatically download all repositories of user/organization
* Stop current clone/updates operation (e.g. for large repository) with Ctrl-C and   move on to the next one
* Update cloned repositories

## Prerequisites

* ```git```

## Install

``` 
$ npm install -g clonem
```

## Usage

```
$ clonem 

  Usage: app [options] <user|organization>

  Options:

    -h, --help     output usage information
    -V, --version  output the version number
    -u, --update   Update (git pull) cloned repositories
    --forked       Only clone forked repositories - TODO
    --own          Only clone own repositories - TODO
    -v, --verbose  Print git tool messages

```

## Example

``` $ clonem github ```


## TODO

* Add option to ignore forked repositories
* Improve logging
* Specify repositories to clone/update
* Set/Get(/create?) token


## Licence

Copyright (c) 2015 [Kostas Lekkas](https://lekkas.io)

The project is licensed under the MIT license.
