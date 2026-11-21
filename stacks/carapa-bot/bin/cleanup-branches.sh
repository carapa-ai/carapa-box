#!/bin/bash
# Delete local branches merged into develop, never the protected main/master/develop.
git for-each-ref --merged=develop --format='%(refname:short)' refs/heads \
  | grep -vxE 'main|master|develop' \
  | xargs -r git branch -d
