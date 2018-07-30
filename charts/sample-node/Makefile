OS := $(shell uname)
CURRENT=$(shell pwd)

NAME := $(shell sed -n 's/^name: //p' Chart.yaml)
VERSION := $(shell cat /home/jenkins/VERSION)

CHARTMUSEUM := $(shell cat /home/jenkins/CHARTMUSEUM)
REGISTRY := $(shell cat /home/jenkins/REGISTRY)

out:
	# "OS: ${OS}"
	# "CURRENT: ${CURRENT}"
	# "NAME: ${NAME}"
	# "VERSION: ${VERSION}"
	# "CHARTMUSEUM: ${CHARTMUSEUM}"
	# "REGISTRY: ${REGISTRY}"

clean:
	rm -rf charts
	rm -rf ${NAME}*.tgz

build: clean
	rm -rf requirements.lock
	helm dependency build
	helm lint

install: clean build
	helm install . --name ${NAME}

upgrade: clean build
	helm upgrade ${NAME} .

release: clean
	helm dependency build
	helm lint
	helm push . chartmuseum

delete:
	helm delete --purge ${NAME}

tag:
ifeq ($(OS),Darwin)
	sed -i "" -e "s/version: .*/version: $(VERSION)/" Chart.yaml
	sed -i "" -e "s|tag: .*|tag: $(VERSION)|" values.yaml
else ifeq ($(OS),Linux)
	sed -i -e "s/version: .*/version: $(VERSION)/" Chart.yaml
	sed -i -e "s|repository: .*|repository: $(REGISTRY)\/$(NAME)|" values.yaml
	sed -i -e "s|tag: .*|tag: $(VERSION)|" values.yaml
else
	echo "platfrom $(OS) not supported to release from"
	exit -1
endif
	# git add --all
	# git commit -m "release $(VERSION)" --allow-empty # if first release then no verion update is performed
	# git tag -fa v$(VERSION) -m "Release version $(VERSION)"
	# git push origin v$(VERSION)
