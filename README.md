# sample-node
```
FROM node:latest
EXPOSE 3000

docker pull nalbam/sample-node:latest (268MB)
docker pull nalbam/sample-node:alpine (24MB)
docker pull nalbam/sample-node:slim   (94MB)
```

## Openshift
### Create project
```
oc new-project ops
oc new-project dev
oc new-project qa

oc policy add-role-to-user admin admin -n ops
oc policy add-role-to-user admin admin -n dev
oc policy add-role-to-user admin admin -n qa
```

### Create app
```
oc new-app jenkins-ephemeral -n ops
oc new-app -f https://raw.githubusercontent.com/nalbam/sample-node/master/openshift/templates/dev.json -n dev
oc new-app -f https://raw.githubusercontent.com/nalbam/sample-node/master/openshift/templates/qa.json -n qa
```

### Create pipeline
```
oc create -f https://raw.githubusercontent.com/nalbam/sample-node/master/openshift/templates/pipeline.yaml -n ops

oc policy add-role-to-user edit system:serviceaccount:ops:jenkins -n dev
oc policy add-role-to-user edit system:serviceaccount:ops:jenkins -n qa

oc policy add-role-to-group system:image-puller system:serviceaccounts:ops -n dev
oc policy add-role-to-group system:image-puller system:serviceaccounts:ops -n qa
oc policy add-role-to-group system:image-puller system:serviceaccounts:qa -n dev
```

### Start Build
```
oc start-build sample-node-pipeline -n ops
```

### Cleanup
```
oc delete project ops dev qa
```

### Github Webhook url
```
Payload URL: https://<host>:8443/oapi/v1/namespaces/dev/buildconfigs/sample-node/webhooks/<secret>/github
Content Type: application/json
Secret: (leave blank)
```
