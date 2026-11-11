//go:build !linux

package main

import "errors"

func runPolicy(policy) error { return errors.New("this helper only works on Linux") }
