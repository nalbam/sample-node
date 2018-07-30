OS := $(shell uname)
CURRENT=$(pwd)

NAME := $(shell sed -n 's/^name: //p' Chart.yaml)
VERSION := $(shell cat ../../../VERSION)

CHARTMUSEUM := $(shell cat ../../../CHARTMUSEUM)
REGISTRY := $(shell cat ../../../REGISTRY)

out:
	echo "OS: ${OS}"
	echo "CURRENT: ${CURRENT}"
	echo "NAME: ${NAME}"
	echo "VERSION: ${VERSION}"
	echo "CHARTMUSEUM: ${CHARTMUSEUM}"
	echo "REGISTRY: ${REGISTRY}"

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
	helm init --client-only
	helm package .
	curl --fail --data-binary "@$(NAME)-$(VERSION).tgz" $(CHARTMUSEUM)/api/charts
	rm -rf ${NAME}*.tgz%

delete:
	helm delete --purge ${NAME}

tag:
ifeq ($(OS),Darwin)
	sed -i "" -e "s/version:.*/version: $(VERSION)/" Chart.yaml
	sed -i "" -e "s|tag: .*|tag: $(VERSION)|" values.yaml
else ifeq ($(OS),Linux)
	sed -i -e "s/version:.*/version: $(VERSION)/" Chart.yaml
	sed -i -e "s|repository: .*|repository: $(REGISTRY)\/$(NAME)|" values.yaml
	sed -i -e "s|tag: .*|tag: $(VERSION)|" values.yaml
else
	echo "platfrom $(OS) not supported to release from"
	exit -1
endif
	git add --all
	git commit -m "release $(VERSION)" --allow-empty # if first release then no verion update is performed
	git tag -fa v$(VERSION) -m "Release version $(VERSION)"
	git push origin v$(VERSION)
