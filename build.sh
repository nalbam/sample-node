#!/bin/bash

OS_NAME="$(uname | awk '{print tolower($0)}')"

SHELL_DIR=$(dirname $0)

RUN_PATH="."

CMD=${1:-$CIRCLE_JOB}

PARAM=${2}

USERNAME=${CIRCLE_PROJECT_USERNAME}
REPONAME=${CIRCLE_PROJECT_REPONAME}

BRANCH=${CIRCLE_BRANCH:-master}

DOCKER_USER=${DOCKER_USER:-$USERNAME}
DOCKER_PASS=${DOCKER_PASS}

# GITHUB_TOKEN=
# PUBLISH_PATH=
# SLACK_TOKEN=

################################################################################

# command -v tput > /dev/null && TPUT=true
TPUT=

_echo() {
    if [ "${TPUT}" != "" ] && [ "$2" != "" ]; then
        echo -e "$(tput setaf $2)$1$(tput sgr0)"
    else
        echo -e "$1"
    fi
}

_result() {
    echo
    _echo "# $@" 4
}

_command() {
    echo
    _echo "$ $@" 3
}

_success() {
    echo
    _echo "+ $@" 2
    exit 0
}

_error() {
    echo
    _echo "- $@" 1
    exit 1
}

_replace() {
    if [ "${OS_NAME}" == "darwin" ]; then
        sed -i "" -e "$1" $2
    else
        sed -i -e "$1" $2
    fi
}

_prepare() {
    # target
    mkdir -p ${RUN_PATH}/target/publish
    mkdir -p ${RUN_PATH}/target/release
}

_package() {
    if [ -z ${DOCKER_PASS} ]; then
        return
    fi
    if [ ! -f ${RUN_PATH}/target/VERSION ]; then
        return
    fi

    VERSION=$(cat ${RUN_PATH}/target/VERSION | xargs)
    _result "VERSION=${VERSION}"

    _command "docker login -u $DOCKER_USER"
    docker login -u $DOCKER_USER -p $DOCKER_PASS

    _command "docker build -t ${USERNAME}/${REPONAME}:${VERSION} ."
    docker build -f ${PARAM:-Dockerfile} -t ${USERNAME}/${REPONAME}:${VERSION} .

    _command "docker push ${USERNAME}/${REPONAME}:${VERSION}"
    docker push ${USERNAME}/${REPONAME}:${VERSION}

    _command "docker logout"
    docker logout
}

_prepare

case ${CMD} in
    build|package)
        _package
esac

_success
